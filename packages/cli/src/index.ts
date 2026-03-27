#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { access, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import ora from "ora";

import {
  createGeneratedConfig,
  deleteProfile,
  getGeneratedConfigPath,
  getStateFilePath,
  listProfiles,
  loadProfile,
  resolveWorkspaceEntryFile,
  saveInstallProfile,
  saveNamedProfile,
  writeGeneratedConfig,
  type ExportedProfile,
} from "./config-store.js";
import { printSection, renderServerTable, renderStatusLabel } from "./output.js";
import { ConfigTarget, type InvocationMode, getRegistryEntry, SERVER_REGISTRY } from "./registry.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function promptForServers(): Promise<string[]> {
  const answers = await inquirer.prompt<{ serverIds: string[] }>([
    {
      type: "checkbox",
      name: "serverIds",
      message: "Which servers should I configure?",
      choices: SERVER_REGISTRY.map((entry) => ({
        name: `${entry.title} — ${entry.description}`,
        value: entry.id,
      })),
      loop: false,
      validate: (value: string[]) => (value.length > 0 ? true : "Pick at least one server."),
    },
  ]);

  return answers.serverIds;
}

async function promptForTarget(): Promise<ConfigTarget> {
  const answers = await inquirer.prompt<{ target: ConfigTarget }>([
    {
      type: "list",
      name: "target",
      message: "Which config format do you want?",
      choices: [
        { name: "Claude Desktop", value: "claude-desktop" },
        { name: "Cursor", value: "cursor" },
        { name: "Raw JSON", value: "json" },
      ],
    },
  ]);

  return answers.target;
}

async function promptForMode(): Promise<InvocationMode> {
  const answers = await inquirer.prompt<{ mode: InvocationMode }>([
    {
      type: "list",
      name: "mode",
      message: "How should the host invoke the servers?",
      choices: [
        { name: "Use npx for portable install snippets", value: "npx" },
        { name: "Use the local workspace build output", value: "workspace" },
      ],
    },
  ]);

  return answers.mode;
}

async function promptForOutputPath(target: ConfigTarget): Promise<string> {
  const defaultPath = getGeneratedConfigPath(target);
  const answers = await inquirer.prompt<{ outputPath: string }>([
    {
      type: "input",
      name: "outputPath",
      message: "Where should I write the generated config?",
      default: defaultPath,
    },
  ]);

  return answers.outputPath;
}

async function generateConfig(
  serverIds: readonly string[],
  target: ConfigTarget,
  mode: InvocationMode,
  writePath?: string,
): Promise<void> {
  const entries = serverIds.map((serverId) => getRegistryEntry(serverId));
  const generatedConfig = createGeneratedConfig(entries, mode);

  if (writePath) {
    await writeGeneratedConfig(writePath, generatedConfig);
    console.log(chalk.green(`Wrote ${target} config to ${writePath}`));
    return;
  }

  console.log(JSON.stringify(generatedConfig, null, 2));
}

async function runServer(serverId: string, transport: "sse" | "stdio", host: string, port: number, supervise?: boolean): Promise<void> {
  const entry = getRegistryEntry(serverId);
  const spinner = ora(`Resolving ${entry.title} package`).start();
  const { getStateDirectory } = await import("./config-store.js");
  
  try {
    const entryFile = resolveWorkspaceEntryFile(entry);
    spinner.succeed(`Launching ${entry.title}`);

    const logDir = path.join(getStateDirectory(), "logs");
    await mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${serverId}.log`);
    const logStream = createWriteStream(logFile, { flags: "a" });
    
    const stateFile = path.join(getStateDirectory(), "state.json");
    let state: { processes: Array<{ serverId: string; pid: number; port?: number; startTime: string; restartCount: number; crashTimes: number[] }> } = { processes: [] };
    try {
      const oldState = await readFile(stateFile, "utf8");
      state = JSON.parse(oldState);
    } catch {}

    let crashTimes: number[] = [];
    let restartCount = 0;
    let currentPid: number | null = null;

    const updateState = async () => {
      state.processes = state.processes.filter(p => p.serverId !== serverId);
      if (currentPid) {
        state.processes.push({
          serverId,
          pid: currentPid,
          port: port,
          startTime: new Date().toISOString(),
          restartCount,
          crashTimes,
        });
      }
      await writeFile(stateFile, JSON.stringify(state, null, 2));
    };

    if (supervise) {
      console.log(chalk.cyan(`[${serverId}] Starting with supervision enabled...`));
      
      while (true) {
        const crashStart = Date.now();
        
        const child = spawn(process.execPath, [entryFile, "--transport", transport, "--host", host, "--port", String(port)], {
          stdio: "inherit",
          cwd: process.cwd(),
        });
        
        currentPid = child.pid || null;
        
        const timestamp = new Date().toISOString();
        logStream.write(`[${timestamp}] Starting server (pid ${child.pid})\n`);
        
        await updateState();

        await new Promise<void>((resolve) => {
          child.on("exit", (code: number | null) => {
            const exitTime = Date.now();
            
            crashTimes = crashTimes.filter(t => exitTime - t < 60000);
            crashTimes.push(exitTime);
            
            logStream.write(`[${new Date().toISOString()}] Server exited with code ${code}\n`);
            
            if (code === 0) {
              currentPid = null;
              logStream.write(`[${new Date().toISOString()}] Server stopped normally\n`);
              logStream.end();
              resolve();
              return;
            }
            
            restartCount++;
            
            if (crashTimes.length >= 5) {
              const errMsg = `[${serverId}] Server crashed 5 times in 60s — giving up. Check logs with: umt logs ${serverId}`;
              console.log(chalk.red(errMsg));
              logStream.write(`[${new Date().toISOString()}] ${errMsg}\n`);
              logStream.end();
              resolve();
              return;
            }
            
            console.log(chalk.yellow(`[${serverId}] Server crashed (code ${code}). Restarting in 2s...`));
            setTimeout(resolve, 2000);
          });
          
          child.on("error", (err: Error) => {
            logStream.write(`[${new Date().toISOString()}] Error: ${err.message}\n`);
          });
        });
        
        if (!currentPid) break;
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [entryFile, "--transport", transport, "--host", host, "--port", String(port)], {
          stdio: "inherit",
          cwd: process.cwd(),
        });
        
        currentPid = child.pid || null;
        
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`${entry.title} exited with code ${code ?? 1}.`));
        });
        
        child.on("error", reject);
      });
    }
  } catch (error) {
    spinner.fail(`Failed to launch ${entry.title}`);
    throw error;
  }
}

async function runDoctor(serverId?: string): Promise<void> {
  const entries = serverId ? [getRegistryEntry(serverId)] : SERVER_REGISTRY;

  printSection("Environment");
  console.log(`Node version: ${chalk.bold(process.version)}`);
  console.log(`State file: ${getStateFilePath()}`);

  printSection("Servers");
  for (const entry of entries) {
    const distPath = resolveWorkspaceEntryFile(entry);
    const distExists = await pathExists(distPath);
    const missingEnv = entry.envVarNames.filter((name) => !process.env[name]);

    console.log(chalk.bold(entry.title));
    console.log(`  Build output: ${renderStatusLabel(distExists)} ${distPath}`);
    console.log(
      `  Environment: ${
        missingEnv.length === 0 ? chalk.green("All set") : chalk.yellow(`Missing ${missingEnv.join(", ")}`)
      }`,
    );
  }
}

async function runUpdate(): Promise<void> {
  const spinner = ora("Checking for updates").start();
  try {
    const currentVersion = "0.1.0";
    const registryOutput = execSync("npm view universal-mcp-toolkit version --registry https://registry.npmjs.org", {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    const latestVersion = registryOutput;

    if (currentVersion === latestVersion) {
      spinner.succeed(`Already up to date (v${currentVersion})`);
      return;
    }

    spinner.info(`Current: v${currentVersion} | Latest: v${latestVersion}`);

    const answers = await inquirer.prompt<{ update: boolean }>([
      {
        type: "confirm",
        name: "update",
        message: `Update to v${latestVersion} now?`,
        default: false,
      },
    ]);

    if (!answers.update) {
      console.log(chalk.gray("Skipped update."));
      return;
    }

    const updateSpinner = ora(`Installing universal-mcp-toolkit@${latestVersion}`).start();
    execSync(`npm install -g universal-mcp-toolkit@${latestVersion}`, {
      stdio: "pipe",
      timeout: 60000,
    });
    updateSpinner.succeed(`Updated to v${latestVersion}`);
  } catch (error) {
    spinner.fail("Failed to check for updates");
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(message));
  }
}

async function runTest(serverId: string): Promise<void> {
  const entry = getRegistryEntry(serverId);

  printSection("Environment check");
  const missingEnv = entry.envVarNames.filter((name) => !process.env[name]);
  if (missingEnv.length > 0) {
    console.log(chalk.yellow(`Warning: Missing env vars: ${missingEnv.join(", ")}`));
  } else {
    console.log(chalk.green("All required environment variables present."));
  }

  printSection("Server handshake");
  const distPath = resolveWorkspaceEntryFile(entry);
  const distExists = await pathExists(distPath);
  if (!distExists) {
    console.log(chalk.red(`Build output not found: ${distPath}`));
    console.log(chalk.gray("Run the build first: corepack pnpm build"));
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Starting ${entry.title} in stdio mode`).start();

  try {
    const child = spawn(process.execPath, [distPath, "--transport", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "umt-test", version: "0.1.0" },
      },
    }) + "\n";

    const toolsListRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) + "\n";

    child.stdin.write(initRequest);

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));

    child.stdin.write(toolsListRequest);

    await new Promise<void>((resolve) => setTimeout(resolve, 1500));

    child.kill();

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    let toolsResponse: unknown = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id === 2 && parsed.result !== undefined) {
          toolsResponse = parsed.result;
          break;
        }
      } catch {
        // skip non-JSON lines
      }
    }

    if (toolsResponse && typeof toolsResponse === "object" && "tools" in toolsResponse) {
      const tools = (toolsResponse as { tools: Array<{ name: string }> }).tools;
      spinner.succeed(`${entry.title} responded with ${tools.length} tool(s)`);
      printSection("Available tools");
      for (const tool of tools) {
        console.log(chalk.green(`  ✓ ${tool.name}`));
      }
      console.log(chalk.green("\nServer handshake successful."));
    } else {
      spinner.fail(`${entry.title} did not return a valid tools/list response`);
      if (stderr.length > 0) {
        console.log(chalk.gray(`\nServer stderr:\n${stderr.slice(0, 500)}`));
      }
      process.exitCode = 1;
    }
  } catch (error) {
    spinner.fail(`Failed to test ${entry.title}`);
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(message));
    process.exitCode = 1;
  }
}

async function runExport(outputPath: string): Promise<void> {
  const { readState } = await import("./config-store.js");
  const state = await readState();

  if (state.installs.length === 0) {
    console.log(chalk.yellow("No install profiles to export. Run `umt install` first."));
    return;
  }

  const seenEnvKeys = new Set<string>();
  for (const install of state.installs) {
    for (const serverId of install.serverIds) {
      try {
        const entry = getRegistryEntry(serverId);
        for (const envName of entry.envVarNames) {
          seenEnvKeys.add(envName);
        }
      } catch {
        // skip unknown server IDs
      }
    }
  }

  const exportData: ExportedProfile = {
    exportedAt: new Date().toISOString(),
    version: "0.1.0",
    profiles: state.installs.map((install, index) => ({
      name: install.profileName ?? `install-${index + 1}`,
      target: install.target,
      mode: install.mode,
      serverIds: install.serverIds,
      envVarKeys: install.serverIds.flatMap((id) => {
        try {
          return [...getRegistryEntry(id).envVarNames];
        } catch {
          return [];
        }
      }),
    })),
  };

  await writeGeneratedConfig(outputPath, exportData as unknown as Parameters<typeof writeGeneratedConfig>[1]);
  console.log(chalk.green(`Exported ${state.installs.length} profile(s) to ${outputPath}`));
  console.log(chalk.gray("Note: credential values are never included in exports."));
}

async function runProfileList(): Promise<void> {
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    console.log(chalk.yellow("No saved profiles. Run `umt install --profile <name>` to create one."));
    return;
  }

  printSection("Saved profiles");
  for (const profile of profiles) {
    console.log(chalk.bold(`  ${profile.name}`));
    console.log(chalk.gray(`    Target: ${profile.target} | Mode: ${profile.mode} | Servers: ${profile.serverIds.join(", ")}`));
    console.log(chalk.gray(`    Config: ${profile.outputPath}`));
    console.log(chalk.gray(`    Created: ${profile.createdAt}`));
  }
}

async function runProfileUse(name: string): Promise<void> {
  const profile = await loadProfile(name);
  const spinner = ora(`Activating profile '${name}'`).start();

  const entries = profile.serverIds.map((id) => getRegistryEntry(id));
  const generatedConfig = createGeneratedConfig(entries, profile.mode);
  await writeGeneratedConfig(profile.outputPath, generatedConfig);
  spinner.succeed(`Applied profile '${name}' to ${profile.outputPath}`);
}

async function runProfileDelete(name: string): Promise<void> {
  await deleteProfile(name);
  console.log(chalk.green(`Deleted profile '${name}'.`));
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("universal-mcp-toolkit")
    .description("A polished control plane for the universal-mcp-toolkit MCP server monorepo.")
    .version("0.1.0");

  program
    .command("list")
    .description("List every available MCP server in the toolkit.")
    .option("--json", "Print the registry as JSON instead of a table.")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify(SERVER_REGISTRY, null, 2));
        return;
      }

      console.log(renderServerTable(SERVER_REGISTRY));
    });

  program
    .command("config")
    .description("Generate a host configuration snippet for one or more servers.")
    .option("-s, --server <serverIds...>", "Server IDs to include.")
    .option("-t, --target <target>", "Config target: claude-desktop, cursor, or json.")
    .option("-m, --mode <mode>", "Invocation mode: npx or workspace.", "npx")
    .option("-w, --write <path>", "Write the config to a file instead of stdout.")
    .action(async (options: { mode: InvocationMode; server?: string[]; target?: ConfigTarget; write?: string }) => {
      const serverIds = options.server?.length ? options.server : await promptForServers();
      const target = options.target ?? (await promptForTarget());
      await generateConfig(serverIds, target, options.mode, options.write);
    });

  program
    .command("install")
    .description("Interactively generate and write a host config file, then save the install profile.")
    .option("--profile <name>", "Save the config under a named profile.")
    .action(async (options: { profile?: string }) => {
      const target = await promptForTarget();
      const serverIds = await promptForServers();
      const mode = await promptForMode();
      const outputPath = await promptForOutputPath(target);

      const spinner = ora(`Writing ${target} config`).start();
      try {
        await generateConfig(serverIds, target, mode, outputPath);
        await saveInstallProfile({
          target,
          mode,
          outputPath,
          serverIds: [...serverIds],
          createdAt: new Date().toISOString(),
          ...(options.profile ? { profileName: options.profile } : {}),
        });

        if (options.profile) {
          await saveNamedProfile({
            name: options.profile,
            target,
            mode,
            outputPath,
            serverIds: [...serverIds],
            createdAt: new Date().toISOString(),
          });
          spinner.succeed(`Saved ${target} install profile as '${options.profile}'`);
        } else {
          spinner.succeed(`Saved ${target} install profile`);
        }
      } catch (error) {
        spinner.fail("Install failed");
        throw error;
      }
    });

  program
    .command("run")
    .description("Run one of the local workspace server packages.")
    .argument("<serverId>", "The server ID to launch.")
    .option("--transport <transport>", "stdio or sse", "stdio")
    .option("--host <host>", "Host for SSE mode.", "127.0.0.1")
    .option("--port <port>", "Port for SSE mode.", "3333")
    .option("--supervise", "Enable auto-restart on crash with crash loop detection.")
    .action(async (serverId: string, options: { host: string; port: string; transport: "sse" | "stdio"; supervise?: boolean }) => {
      await runServer(serverId, options.transport, options.host, Number.parseInt(options.port, 10), options.supervise);
    });

  program
    .command("doctor")
    .description("Check build outputs and required environment variables.")
    .argument("[serverId]", "Optionally scope the checks to one server.")
    .action(async (serverId?: string) => {
      await runDoctor(serverId);
    });

  program
    .command("update")
    .description("Check for updates and optionally install the latest version from npm.")
    .action(async () => {
      await runUpdate();
    });

  program
    .command("test")
    .description("Run a live end-to-end test of a server via stdio transport.")
    .argument("<serverId>", "The server ID to test.")
    .action(async (serverId: string) => {
      await runTest(serverId);
    });

  program
    .command("export")
    .description("Export install profiles to a portable JSON file (without secret values).")
    .option("-o, --output <file>", "Output file path.", "umt-profile-export.json")
    .action(async (options: { output: string }) => {
      await runExport(options.output);
    });

  const profileCmd = program
    .command("profile")
    .description("Manage saved install profiles.");

  profileCmd
    .command("list")
    .description("List all saved profiles.")
    .action(async () => {
      await runProfileList();
    });

  profileCmd
    .command("use")
    .description("Activate a saved profile by writing its config to disk.")
    .argument("<name>", "The profile name to activate.")
    .action(async (name: string) => {
      await runProfileUse(name);
    });

  profileCmd
    .command("delete")
    .description("Remove a saved profile.")
    .argument("<name>", "The profile name to delete.")
    .action(async (name: string) => {
      await runProfileDelete(name);
    });

  const statusCmd = program
    .command("status")
    .description("Show currently running umt server processes.");

  statusCmd.action(async () => {
    await runStatus();
  });

  program
    .command("logs")
    .description("Tail the log file for a specific server.")
    .argument("<serverName>", "The server name to tail logs for.")
    .option("--lines <n>", "Number of lines to display.", "50")
    .option("--follow", "Stream new lines as they are added.")
    .action(async (serverName: string, options: { lines: string; follow?: boolean }) => {
      await runLogs(serverName, parseInt(options.lines, 10), !!options.follow);
    });

  program
    .command("upgrade")
    .description("Check npm registry for newer versions and upgrade.")
    .option("--all", "Upgrade all packages without prompting.")
    .argument("[serverName]", "Specific server to upgrade.")
    .action(async (options: { all?: boolean }, serverName?: string) => {
      await runUpgrade(options.all ?? false, serverName);
    });

  program
    .command("init")
    .description("Interactive setup wizard for new users.")
    .action(async () => {
      await runInit();
    });

  program
    .command("search")
    .description("Search available servers by name, description, and tags.")
    .argument("<query>", "Search query.")
    .action(async (query: string) => {
      await runSearch(query);
    });

  program
    .command("export-config")
    .description("Export current server configuration in client-specific format.")
    .option("--format <format>", "Config format: claude, cursor, vscode, all.", "claude")
    .option("--output <path>", "Output file path.")
    .action(async (options: { format: string; output?: string }) => {
      await runExportConfig(options.format, options.output);
    });

  program
    .command("link")
    .description("Link to local MemOS/ContextCore memory database.")
    .argument("[memos]", "Link to memos.")
    .option("--db-path <path>", "Path to MemOS SQLite database.")
    .action(async (options: { dbPath?: string }) => {
      await runLinkMemos(options.dbPath);
    });

  const profileCmd2 = program.command("profile");
  
  profileCmd2
    .command("create")
    .description("Create a new named profile with interactive wizard.")
    .argument("<name>", "Profile name.")
    .action(async (name: string) => {
      await runProfileCreate(name);
    });

  profileCmd2
    .command("show")
    .description("Show profile configuration.")
    .argument("[name]", "Profile name (shows active if not provided).")
    .action(async (name?: string) => {
      await runProfileShow(name);
    });

  profileCmd2
    .command("export")
    .description("Export a profile as a portable JSON file.")
    .argument("<name>", "Profile name.")
    .option("--output <path>", "Output file path.")
    .action(async (options: { output?: string }, name: string) => {
      await runProfileExport(name, options.output);
    });

  profileCmd2
    .command("import")
    .description("Import a profile from a JSON file.")
    .argument("<path>", "Path to profile JSON file.")
    .action(async (profilePath: string) => {
      await runProfileImport(profilePath);
    });

  await program.parseAsync(argv);
}

async function runStatus(): Promise<void> {
  try {
    const { getStateDirectory } = await import("./config-store.js");
    const statePath = path.join(getStateDirectory(), "state.json");
    
    if (!(await pathExists(statePath))) {
      console.log(chalk.yellow("No servers currently running."));
      console.log(chalk.gray("Use 'umt run <server>' to start a server."));
      return;
    }
    
    const contents = await readFile(statePath, "utf8");
    const state = JSON.parse(contents);
    
    if (!state.processes || state.processes.length === 0) {
      console.log(chalk.yellow("No servers currently running."));
      console.log(chalk.gray("Use 'umt run <server>' to start a server."));
      return;
    }
    
    printSection("Running Servers");
    console.log(chalk.cyan("Server".padEnd(20)) + chalk.cyan("PID").padEnd(12) + chalk.cyan("Port").padEnd(10) + chalk.cyan("Uptime").padEnd(15) + chalk.cyan("Restarts"));
    
    for (const proc of state.processes) {
      const startTime = new Date(proc.startTime);
      const uptime = Date.now() - startTime.getTime();
      const uptimeStr = uptime < 60000 ? "<1m" : `${Math.floor(uptime / 60000)}m`;
      console.log(
        proc.serverId.padEnd(20) +
        String(proc.pid).padEnd(12) +
        String(proc.port || "-").padEnd(10) +
        uptimeStr.padEnd(15) +
        String(proc.restartCount || 0)
      );
    }
  } catch (error) {
    console.log(chalk.yellow("No servers currently running."));
    console.log(chalk.gray("Use 'umt run <server>' to start a server."));
  }
}

async function runLogs(serverName: string, lines: number, follow: boolean): Promise<void> {
  try {
    const { getStateDirectory } = await import("./config-store.js");
    const logDir = path.join(getStateDirectory(), "logs");
    const logFile = path.join(logDir, `${serverName}.log`);
    
    if (!(await pathExists(logFile))) {
      console.log(chalk.red(`No logs found for '${serverName}'.`));
      return;
    }
    
    if (follow) {
      console.log(chalk.gray(`Following logs for ${serverName}... (Ctrl+C to stop)`));
      const stream = createReadStream(logFile);
      const rl = createInterface({ input: stream });
      
      stream.on('error', (err) => {
        console.log(chalk.red(`Error reading log: ${err.message}`));
      });
      
      rl.on('line', (line) => {
        console.log(line);
      });
    } else {
      const contents = await readFile(logFile, "utf8");
      const allLines = contents.split("\n");
      const lastLines = allLines.slice(-lines);
      console.log(lastLines.join("\n"));
    }
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

async function runUpgrade(allPackages: boolean, serverName?: string): Promise<void> {
  const spinner = ora("Checking for updates...").start();
  
  try {
    if (serverName) {
      const entry = getRegistryEntry(serverName);
      const result = execSync(`npm view ${entry.packageName} version`, { encoding: "utf8" }).trim();
      spinner.succeed(`Current version: ${entry.packageName}`);
      console.log(`Latest version in npm: ${chalk.green(result)}`);
    } else if (allPackages) {
      const packages = SERVER_REGISTRY.map(e => e.packageName);
      for (const pkg of packages) {
        const result = execSync(`npm view ${pkg} version`, { encoding: "utf8" }).trim();
        console.log(`${pkg}: ${chalk.green(result)}`);
      }
      spinner.succeed("All packages checked.");
    } else {
      const pkg = "@universal-mcp-toolkit/cli";
      const result = execSync(`npm view ${pkg} version`, { encoding: "utf8" }).trim();
      spinner.succeed(`CLI version: ${chalk.green(result)}`);
    }
  } catch (error) {
    spinner.fail("Failed to check for updates");
  }
}

async function runInit(): Promise<void> {
  const target = await promptForTarget();
  const serverIds = await promptForServers();
  const mode = await promptForMode();
  const outputPath = await promptForOutputPath(target);

  const spinner = ora("Writing config...").start();
  try {
    await generateConfig(serverIds, target, mode, outputPath);
    spinner.succeed(`Config written to ${outputPath}`);
    printSection("Next Steps");
    console.log(chalk.white("1. Set required environment variables in your shell"));
    console.log(chalk.white("2. Restart your MCP host (Claude Desktop, Cursor, etc.)"));
    console.log(chalk.white("3. Run 'umt doctor' to verify configuration"));
  } catch (error) {
    spinner.fail("Init failed");
    throw error;
  }
}

async function runSearch(query: string): Promise<void> {
  const lowerQuery = query.toLowerCase();
  const matches = SERVER_REGISTRY.filter(entry => 
    entry.id.toLowerCase().includes(lowerQuery) ||
    entry.title.toLowerCase().includes(lowerQuery) ||
    entry.description.toLowerCase().includes(lowerQuery)
  );
  
  if (matches.length === 0) {
    console.log(chalk.yellow(`No servers found matching '${query}'.`));
    return;
  }
  
  console.log(renderServerTable(matches));
}

async function runExportConfig(format: string, outputPath?: string): Promise<void> {
  try {
    const { loadActiveProfile } = await import("./config-store.js");
    const profile = await loadActiveProfile();
    
    if (!profile) {
      console.log(chalk.yellow("No active profile. Run 'umt init' or 'umt profile use' first."));
      return;
    }
    
    const entries = profile.serverIds.map(id => getRegistryEntry(id));
    const config = createGeneratedConfig(entries, profile.mode);
    
    const target = format === "cursor" ? "cursor" : format === "vscode" ? "json" : "claude-desktop";
    
    if (outputPath) {
      await writeFile(outputPath, JSON.stringify(config, null, 2));
      console.log(chalk.green(`Config written to ${outputPath}`));
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

async function runLinkMemos(dbPath?: string): Promise<void> {
  const { getStateDirectory } = await import("./config-store.js");
  const configDir = getStateDirectory();
  
  let pathToUse = dbPath;
  
  if (!pathToUse) {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const defaultPaths = [path.join(home, ".memos", "memos.db"), path.join(home, "memos.db")];
    
    for (const p of defaultPaths) {
      if (existsSync(p)) {
        pathToUse = p;
        break;
      }
    }
    
    if (!pathToUse) {
      console.log(chalk.red("No db-path provided and no default MemOS database found."));
      console.log(chalk.gray("Please provide --db-path or place memos.db in ~/.memos/"));
      return;
    }
  }
  
  const configPath = path.join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  
  const config = { memosPath: pathToUse };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  
  console.log(chalk.green(`MemOS linked at ${pathToUse}.`));
  console.log(chalk.gray("MCP servers can now access ContextCore memory."));
}

async function runProfileCreate(name: string): Promise<void> {
  const target = await promptForTarget();
  const serverIds = await promptForServers();
  const mode = await promptForMode();
  const outputPath = await promptForOutputPath(target);
  
  const spinner = ora(`Creating profile '${name}'...`).start();
  try {
    await generateConfig(serverIds, target, mode, outputPath);
    await saveNamedProfile({
      name,
      target,
      mode,
      outputPath,
      serverIds,
      createdAt: new Date().toISOString(),
    });
    spinner.succeed(`Profile '${name}' created`);
  } catch (error) {
    spinner.fail("Failed to create profile");
    throw error;
  }
}

async function runProfileShow(name?: string): Promise<void> {
  try {
    const { loadActiveProfile, readState } = await import("./config-store.js");
    
    let profile;
    if (name) {
      profile = await loadProfile(name);
    } else {
      profile = await loadActiveProfile();
    }
    
    if (!profile) {
      console.log(chalk.yellow("No profile found. Create one with 'umt init' or 'umt profile create'."));
      return;
    }
    
    printSection(`Profile: ${name || "Active"}`);
    console.log(`Target: ${profile.target}`);
    console.log(`Mode: ${profile.mode}`);
    console.log(`Output: ${profile.outputPath}`);
    console.log(`Servers: ${profile.serverIds.join(", ")}`);
    console.log(`Created: ${profile.createdAt}`);
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

async function runProfileExport(name: string, outputPath?: string): Promise<void> {
  try {
    const profile = await loadProfile(name);
    const exportPath = outputPath || `${name}-profile.json`;
    await writeFile(exportPath, JSON.stringify(profile, null, 2));
    console.log(chalk.green(`Profile '${name}' exported to ${exportPath}`));
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

async function runProfileImport(profilePath: string): Promise<void> {
  try {
    const contents = await readFile(profilePath, "utf8");
    const profile = JSON.parse(contents);
    
    if (!profile.name) {
      console.log(chalk.red("Invalid profile: missing 'name' field."));
      return;
    }
    
    const spinner = ora(`Importing profile '${profile.name}'...`).start();
    await saveNamedProfile(profile);
    spinner.succeed(`Profile '${profile.name}' imported`);
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown CLI failure";
    console.error(chalk.red(message));
    process.exit(1);
  });
}
