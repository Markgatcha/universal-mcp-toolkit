#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ora from "ora";

import {
  createGeneratedConfig,
  getGeneratedConfigPath,
  getStateFilePath,
  resolveWorkspaceEntryFile,
  saveInstallProfile,
  writeGeneratedConfig,
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
    .action(async () => {
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
        });
        spinner.succeed(`Saved ${target} install profile`);
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

  await program.parseAsync(argv);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown CLI failure";
    console.error(chalk.red(message));
    process.exit(1);
  });
}
