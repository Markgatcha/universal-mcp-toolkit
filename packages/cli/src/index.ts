#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

async function runServer(serverId: string, transport: "sse" | "stdio", host: string, port: number): Promise<void> {
  const entry = getRegistryEntry(serverId);
  const spinner = ora(`Resolving ${entry.title} package`).start();

  try {
    const entryFile = resolveWorkspaceEntryFile(entry);
    spinner.succeed(`Launching ${entry.title}`);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [entryFile, "--transport", transport, "--host", host, "--port", String(port)], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`${entry.title} exited with code ${code ?? 1}.`));
      });

      child.on("error", reject);
    });
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
    .action(async (serverId: string, options: { host: string; port: string; transport: "sse" | "stdio" }) => {
      await runServer(serverId, options.transport, options.host, Number.parseInt(options.port, 10));
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

  await program.parseAsync(argv);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown CLI failure";
    console.error(chalk.red(message));
    process.exit(1);
  });
}
