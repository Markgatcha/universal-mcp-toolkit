#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { access, readFile, writeFile, mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// ora is imported lazily (~70ms of module load, measured): most commands never
// show a spinner, so paying for it on every CLI startup is pure overhead.
// Use oraLazy() at the call sites that need a spinner instead.
let oraModule: typeof import("ora") | undefined;
async function oraLazy(text: string): Promise<import("ora").Ora> {
  oraModule ??= await import("ora");
  return oraModule.default(text);
}

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };
const CLI_VERSION = _pkg.version;
const { execFile } = await import("node:child_process");
const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";

/**
 * Run `npm` with cross-platform arg resolution. On Windows `npm` is a `.cmd`
 * shim that `execFile` cannot launch without a shell, so `shell: true` is
 * required there (ENOENT otherwise). All args are fixed/registry-derived, so
 * the shell's quoting surface is not a concern here.
 */
async function execNpm(args: string[], options: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("npm", args, { windowsHide: true, shell: IS_WINDOWS, ...options });
}

type InquirerQuestion = {
  type: string;
  name: string;
  message: string;
  choices?: Array<{ name: string; value: string }>;
  loop?: boolean;
  validate?: (value: any) => true | string;
  default?: unknown;
};

async function promptForAnswers<T = Record<string, unknown>>(questions: InquirerQuestion[]): Promise<T> {
  const { default: inquirer } = await import("inquirer");
  return inquirer.prompt(questions as never) as Promise<T>;
}

import {
  createGeneratedConfig,
  deleteProfile,
  getGeneratedConfigPath,
  getStateFilePath,
  readState,
  isLocalWorkspaceServer,
  listProfiles,
  loadProfile,
  resolveWorkspaceEntryFile,
  saveInstallProfile,
  saveNamedProfile,
  writeGeneratedConfig,
  type ExportedProfile,
} from "./config-store.js";
import { printSection, renderServerTable, renderStatusLabel, renderToolTable } from "./output.js";
import { checkForUpdate } from "./update-notifier.js";
import { ConfigTarget, type InvocationMode, type ServerRegistryEntry, findServersDeclaringTool, getRegistryEntry, SERVER_REGISTRY } from "./registry.js";
import { loadPlugin, checkPluginAvailability, getSpawnConfig, clearPluginCache, type PluginLoadMode } from "./plugin-loader.js";
import { DEFAULT_MCP_REGISTRY_URL, fetchRegistryServers } from "./registry-discovery.js";
import { executeWorkflow, parseWorkflowJson } from "./workflow.js";
import { createWorkspaceBuildArgs } from "./workspace-build.js";
import type {
  BridgeTool,
  BridgeToolResult,
  MCPFunctionCallingBridge,
  MrtrInputRequests,
  MrtrInputResponses,
} from "@universal-mcp-toolkit/bridge";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function buildWorkspacePackages(packageNames: readonly string[]): Promise<void> {
  const args = createWorkspaceBuildArgs(packageNames);
  if (args.length === 0) return;

  await execFileAsync("pnpm", args, {
    cwd: process.cwd(),
    shell: IS_WINDOWS,
    timeout: 120000,
  });
}

async function promptForServers(): Promise<string[]> {
  const answers = await promptForAnswers<{ serverIds: string[] }>([
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
  const answers = await promptForAnswers<{ target: ConfigTarget }>([
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

/**
 * Recursively walk a parsed JSON value and replace any string equal to
 * "__PIPE__" with the piped source output. This is more robust than
 * string-replace on JSON because it only replaces exact string matches,
 * never partial substrings inside other strings.
 */
function substitutePipe(obj: unknown, pipeValue: string): unknown {
  if (typeof obj === "string") {
    return obj === "__PIPE__" ? pipeValue : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substitutePipe(item, pipeValue));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substitutePipe(val, pipeValue);
    }
    return result;
  }
  return obj;
}

/**
 * Resolve a ServerRegistryEntry into a BridgeServerConfig that the
 * MCPFunctionCallingBridge can use to connect via stdio.
 * For npx-based servers, we spawn \`npx -y <packageName> <npxArgs>\`.
 */
async function resolveBridgeConfig(entry: ServerRegistryEntry) {
  // Companion packages may provide their complete npx invocation. Otherwise,
  // use the standard package launch shape shared by first-party servers.
  const args = entry.npxArgs ? [...entry.npxArgs] : ["-y", entry.packageName];
  return {
    transport: "stdio" as const,
    commandOrUrl: "npx",
    args,
  };
}

/**
 * Connect a bridge to a registry server, preferring the local workspace
 * build (auto-building when missing, like `umt run`) and falling back to
 * the npx invocation for external companion packages.
 *
 * The caller owns the bridge and must call `disconnect()` when done.
 */
async function connectBridgeToEntry(entry: ServerRegistryEntry) {
  const { MCPFunctionCallingBridge } = await import("@universal-mcp-toolkit/bridge");
  if (isLocalWorkspaceServer(entry)) {
    const distPath = resolveWorkspaceEntryFile(entry);
    if (!(await pathExists(distPath))) {
      await buildWorkspacePackages([entry.packageName]);
    }
    if (!(await pathExists(distPath))) {
      throw new Error(
        `Build output not found: ${distPath}. Build it first: pnpm --filter ${entry.packageName} build`,
      );
    }
    const bridge = new MCPFunctionCallingBridge({
      transport: "stdio" as const,
      commandOrUrl: process.execPath,
      args: [distPath, "--transport", "stdio"],
      // Forward the user's environment to the spawned server. The MCP SDK's
      // StdioClientTransport only inherits an allowlist of env vars by
      // default, which silently drops server-required variables such as
      // FILESYSTEM_ROOTS. `umt run` spawns with full env inheritance, so
      // `umt tools` matches that behavior for local workspace servers.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    await bridge.connect();
    return bridge;
  }
  const bridge = new MCPFunctionCallingBridge(await resolveBridgeConfig(entry));
  await bridge.connect();
  return bridge;
}

/**
 * Resolve a `umt vet` / `umt add` target argument — a registry server id or
 * an http(s) URL — into a core `VetTarget`. Mirrors `connectBridgeToEntry`'s
 * launch config so vetting probes the same server the other commands use.
 * The caller owns nothing persistent; each probe opens its own connection.
 */
async function resolveVetTarget(arg: string): Promise<import("./vet.js").VetTarget> {
  const { isUrlTarget, urlVetTarget, registryStdioTarget } = await import("./vet.js");
  if (isUrlTarget(arg)) return urlVetTarget(arg);
  const entry = getRegistryEntry(arg);
  if (isLocalWorkspaceServer(entry)) {
    const distPath = resolveWorkspaceEntryFile(entry);
    if (!(await pathExists(distPath))) {
      await buildWorkspacePackages([entry.packageName]);
    }
    if (!(await pathExists(distPath))) {
      throw new Error(
        `Build output not found: ${distPath}. Build it first: pnpm --filter ${entry.packageName} build`,
      );
    }
    return registryStdioTarget(entry, {
      command: process.execPath,
      args: [distPath, "--transport", "stdio"],
      // Same full-env inheritance as `connectBridgeToEntry`, so vetting sees
      // the server exactly as `umt tools` would.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
  }
  const args = entry.npxArgs ? [...entry.npxArgs] : ["-y", entry.packageName];
  return registryStdioTarget(entry, { command: "npx", args });
}

/**
 * Resolve which registry server declares a tool (shared by `tools call`).
 * Throws a human-readable error when ambiguous or unknown.
 */
function resolveToolEntry(toolName: string, serverId?: string): ServerRegistryEntry {
  if (serverId) {
    const entry = getRegistryEntry(serverId);
    if (!entry.toolNames.includes(toolName)) {
      console.log(
        chalk.yellow(
          `Warning: server '${entry.id}' does not declare '${toolName}' in the registry; querying it anyway.`,
        ),
      );
    }
    return entry;
  }
  const candidates = findServersDeclaringTool(toolName);
  if (candidates.length === 0) {
    throw new Error(`No server in the registry declares a tool named '${toolName}'.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Tool '${toolName}' is declared by several servers (${candidates.map((c) => c.id).join(", ")}). ` +
      "Re-run with --server <id>.",
    );
  }
  return candidates[0]!;
}

/**
 * Parse `--args` JSON into a tool-arguments object.
 * Throws a human-readable error on invalid input.
 */
function parseToolArgsJson(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Invalid --args JSON: ${json.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--args must be a JSON object, e.g. --args '{\"key\":\"value\"}'.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Print a tool result (text or JSON).
 */
function printToolResult(
  toolName: string,
  result: BridgeToolResult,
  json?: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printSection(`Result: ${toolName}`);
  console.log(result.output);
  if (result.error) {
    console.error(chalk.red("\n[Tool returned an error]"));
    process.exitCode = 1;
  }
}

/**
 * MRTR input handler for the CLI: surface each `inputRequest` as an
 * interactive prompt, then build the `inputResponses` envelope.
 */
async function collectMrtrInputs(
  requests: MrtrInputRequests,
): Promise<MrtrInputResponses> {
  const { planMrtrPrompts, buildMrtrResponses } = await import("./task-cli.js");
  const plans = planMrtrPrompts(requests);
  const answersByKey: Record<string, Record<string, unknown>> = {};
  for (const plan of plans) {
    console.log(chalk.cyan(`\n${plan.headline}`));
    answersByKey[plan.key] = await promptForAnswers<Record<string, unknown>>(plan.questions);
  }
  return buildMrtrResponses(plans, answersByKey);
}

/**
 * Run a tool as a long-running task: spawn, stream progress, await the
 * final result. Falls back to a direct MRTR call when the server does not
 * advertise task support (dual-era compatibility).
 */
async function runToolAsTask(
  bridge: MCPFunctionCallingBridge,
  entry: ServerRegistryEntry,
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: { taskTtl?: string; taskPoll?: string; json?: boolean },
): Promise<void> {
  const support = bridge.getTaskSupport();
  if (!support.toolsCallTasks) {
    console.log(
      chalk.yellow(
        `Server '${entry.id}' does not advertise task support (2026-07-28 Tasks) — ` +
        "falling back to a direct call.",
      ),
    );
    const result = await bridge.callToolWithMrtr(toolName, toolArgs, {
      onInputRequest: collectMrtrInputs,
    });
    printToolResult(toolName, result, options.json);
    return;
  }

  const spawned = await bridge.spawnTaskToolCall(toolName, toolArgs, {
    ...(options.taskTtl !== undefined ? { ttlMs: parseInt(options.taskTtl, 10) } : {}),
    ...(options.taskPoll !== undefined ? { pollIntervalMs: parseInt(options.taskPoll, 10) } : {}),
  });
  if (spawned.result) {
    console.log(chalk.gray("The server executed synchronously — no task was created."));
    printToolResult(toolName, spawned.result, options.json);
    return;
  }

  console.log(`Task spawned: ${chalk.bold(spawned.taskId)}`);
  const spinner = (await oraLazy("Waiting for task...")).start();
  try {
    const result = await bridge.awaitTaskCompletion(spawned.taskId!, {
      onProgress: (task) => {
        spinner.text =
          `Task ${spawned.taskId}: ${task.status}` +
          (task.statusMessage ? ` — ${task.statusMessage}` : "");
      },
    });
    spinner.succeed(`Task ${spawned.taskId} completed.`);
    printToolResult(toolName, result, options.json);
  } catch (error) {
    spinner.fail(`Task ${spawned.taskId} did not complete.`);
    throw error;
  }
}

/**
 * Refresh the tools listing after connect so the definition-drift pin is
 * compared and `definition-drift` events fire. Warns (but does not fail)
 * when the listing cannot be refreshed.
 */
async function refreshToolListingForDriftCheck(
  bridge: MCPFunctionCallingBridge,
  entry: ServerRegistryEntry,
): Promise<void> {
  try {
    await bridge.listTools({ refresh: true });
  } catch (error) {
    console.error(
      chalk.yellow(
        `Warning: could not refresh tools/list on '${entry.id}' for drift check: ` +
        (error instanceof Error ? error.message : String(error)),
      ),
    );
  }
}

/**
 * Connect to a registry server for `umt task` commands, attach the
 * definition-drift watcher, run `fn`, and always disconnect.
 */
async function withTaskBridge(
  serverId: string,
  fn: (bridge: MCPFunctionCallingBridge, entry: ServerRegistryEntry) => Promise<void>,
): Promise<void> {
  const entry = getRegistryEntry(serverId);
  const { watchDefinitionDrift } = await import("./task-cli.js");
  const spinner = (await oraLazy(`Connecting to ${entry.title}...`)).start();
  let bridge: MCPFunctionCallingBridge | undefined;
  try {
    bridge = await connectBridgeToEntry(entry);
    spinner.succeed(`Connected to ${entry.title}.`);
    const stopWatching = watchDefinitionDrift(bridge, entry.id);
    try {
      await refreshToolListingForDriftCheck(bridge, entry);
      await fn(bridge, entry);
    } finally {
      stopWatching();
    }
  } catch (error) {
    spinner.fail(`Task command failed.`);
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  } finally {
    await bridge?.disconnect().catch(() => undefined);
  }
}

async function promptForMode(): Promise<InvocationMode> {
  const answers = await promptForAnswers<{ mode: InvocationMode }>([
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
  const answers = await promptForAnswers<{ outputPath: string }>([
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

async function runServer(serverId: string, transport: "sse" | "stdio" | "streamable-http", host: string, port: number, supervise?: boolean, logLevel?: string): Promise<void> {
  const entry = getRegistryEntry(serverId);
  const spinner = (await oraLazy(`Resolving ${entry.title} package`)).start();
  const { getStateDirectory } = await import("./config-store.js");
  
  // Set log level from CLI flag (overrides LOG_LEVEL env var)
  if (logLevel) {
    process.env.LOG_LEVEL = logLevel;
  }
  
  try {
    const entryFile = resolveWorkspaceEntryFile(entry);
    
    // Auto-build only the local workspace package when its output is missing.
    if (!(await pathExists(entryFile)) && isLocalWorkspaceServer(entry)) {
      spinner.info(`Build output missing for ${entry.title}. Building...`);
      await buildWorkspacePackages([entry.packageName]);
      spinner.succeed(`Built ${entry.title}`);
    }
    
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
          windowsHide: IS_WINDOWS,
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
          windowsHide: IS_WINDOWS,
        });

        currentPid = child.pid || null;

        child.on("exit", async (code) => {
          currentPid = null;
          await updateState();
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

/**
 * Run the doctor command, which checks build outputs and required environment
 * variables for all (or a single) server. When `fix` is true, it attempts to
 * auto-heal common issues:
 *  - Writes missing env vars from `.env.example` as placeholders
 *  - Builds missing local workspace packages when their `dist/` output is missing
 *
 * @param serverId - Optional server ID to scope checks to one server
 * @param fix - When true, attempt to auto-heal issues instead of just reporting
 * @param vet - When true, also run the live `umt vet` probe as a non-blocking
 *   sub-check (scoped server, or every `umt add`-registered server)
 */
async function runDoctor(serverId?: string, fix?: boolean, vet?: boolean): Promise<void> {
  const entries = serverId ? [getRegistryEntry(serverId)] : SERVER_REGISTRY;
  const missingLocalEntries: ServerRegistryEntry[] = [];

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

    // Collect missing local packages so doctor can build them in one targeted command.
    if (fix && !distExists && isLocalWorkspaceServer(entry)) {
      missingLocalEntries.push(entry);
    }

    // Auto-heal: write missing env vars from .env.example
    if (fix && missingEnv.length > 0) {
      const envExamplePath = path.join(process.cwd(), ".env.example");
      if (await pathExists(envExamplePath)) {
        const envExample = await readFile(envExamplePath, "utf8");
        const envLines = envExample.split("\n");
        const newEnvLines: string[] = [];
        for (const name of missingEnv) {
          const existing = envLines.find((line) => line.startsWith(`${name}=`));
          if (existing) {
            newEnvLines.push(existing);
          } else {
            newEnvLines.push(`${name}=`);
          }
        }
        const envPath = path.join(process.cwd(), ".env.local");
        let existingEnv = "";
        try {
          existingEnv = await readFile(envPath, "utf8");
        } catch {}
        const merged = existingEnv + "\n" + newEnvLines.join("\n");
        await writeFile(envPath, merged, "utf8");
        console.log(chalk.green(`  Wrote ${missingEnv.length} missing env var(s) to .env.local`));
      }
    }
  }

  if (fix && missingLocalEntries.length > 0) {
    const titles = missingLocalEntries.map((entry) => entry.title).join(", ");
    const spinner = (await oraLazy(`Building ${titles}...`)).start();
    try {
      await buildWorkspacePackages(missingLocalEntries.map((entry) => entry.packageName));
      spinner.succeed(`Built ${titles}`);
    } catch (error) {
      spinner.fail(`Failed to build ${titles}`);
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(chalk.red(message));
    }
  }

  if (vet) {
    const { runDoctorVet } = await import("./vet.js");
    if (serverId) {
      await runDoctorVet(await resolveVetTarget(serverId));
    } else {
      const { addedServers } = await readState();
      if (!addedServers || addedServers.length === 0) {
        console.log(chalk.yellow("\n  --vet needs a server: pass a server id, or register one with `umt add` first."));
      } else {
        for (const added of addedServers) {
          await runDoctorVet(await resolveVetTarget(added.target));
        }
      }
    }
  }
}

async function runUpdate(): Promise<void> {
  const spinner = (await oraLazy("Checking for updates")).start();
  try {
    const currentVersion = CLI_VERSION;
    const { stdout: registryOutput } = await execNpm(["view", "universal-mcp-toolkit", "version", "--registry", "https://registry.npmjs.org"], {
      timeout: 15000,
    });
    const latestVersion = registryOutput.trim();

    if (currentVersion === latestVersion) {
      spinner.succeed(`Already up to date (v${currentVersion})`);
      return;
    }

    spinner.info(`Current: v${currentVersion} | Latest: v${latestVersion}`);

    const answers = await promptForAnswers<{ update: boolean }>([
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

    const updateSpinner = (await oraLazy(`Installing universal-mcp-toolkit@${latestVersion}`)).start();
    await execNpm(["install", "-g", `universal-mcp-toolkit@${latestVersion}`], {
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

  const spinner = (await oraLazy(`Starting ${entry.title} in stdio mode`)).start();

  try {
    const child = spawn(process.execPath, [distPath, "--transport", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      windowsHide: IS_WINDOWS,
    });

    let stderr = "";

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

    let buffer = "";
    const pendingResponses = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timeout: NodeJS.Timeout }>();

    const waitForResponse = (id: number): Promise<unknown> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingResponses.delete(id);
        reject(new Error(`Timed out waiting for response ${id}.`));
      }, 5000);

      pendingResponses.set(id, { resolve, reject, timeout });
    });

    const failPendingResponses = (reason: Error): void => {
      for (const pending of pendingResponses.values()) {
        clearTimeout(pending.timeout);
        pending.reject(reason);
      }
      pendingResponses.clear();
    };

    const flushLines = (): void => {
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: unknown };
          if (typeof parsed.id === "number") {
            const pending = pendingResponses.get(parsed.id);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingResponses.delete(parsed.id);
              if (parsed.error !== undefined) {
                pending.reject(new Error(JSON.stringify(parsed.error)));
              } else {
                pending.resolve(parsed.result);
              }
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      flushLines();
    });

    child.once("exit", (code) => {
      if (code !== 0) {
        failPendingResponses(new Error(`Server exited before completing handshake (code ${code ?? 1}).`));
      }
    });

    child.once("error", (error) => {
      failPendingResponses(error instanceof Error ? error : new Error("Server process error."));
    });

    child.stdin.write(initRequest);
    const initResponse = waitForResponse(1);
    child.stdin.write(toolsListRequest);
    const toolsResponsePromise = waitForResponse(2);

    await initResponse;
    const toolsResponse = await toolsResponsePromise;

    child.kill();

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

async function runConformance(serverId?: string): Promise<void> {
  const entries = serverId ? [getRegistryEntry(serverId)] : SERVER_REGISTRY;
  const rows: Array<{ id: string; status: "pass" | "skip" | "fail"; detail: string }> = [];

  for (const entry of entries) {
    const hasMetadata =
      entry.id.length > 0 &&
      entry.title.length > 0 &&
      entry.packageName.length > 0 &&
      entry.transports.length > 0;

    if (!hasMetadata) {
      rows.push({ id: entry.id || "(missing)", status: "fail", detail: "Registry metadata is incomplete." });
      continue;
    }

    const npxConfig = createGeneratedConfig([entry], "npx").mcpServers[entry.id];
    if (!npxConfig?.command || npxConfig.args.length === 0) {
      rows.push({ id: entry.id, status: "fail", detail: "Could not generate an npx stdio config." });
      continue;
    }

    const distPath = resolveWorkspaceEntryFile(entry);
    const distExists = await pathExists(distPath);
    if (!distExists) {
      const detail = entry.npxArgs
        ? `External MCP entry configured as: npx ${entry.npxArgs.join(" ")}`
        : `Workspace build output missing: ${distPath}`;
      rows.push({ id: entry.id, status: entry.npxArgs ? "pass" : "skip", detail });
      continue;
    }

    try {
      const tools = await runStdioHandshake(distPath, 5000);
      rows.push({ id: entry.id, status: "pass", detail: `stdio initialize/tools-list returned ${tools} tool(s).` });
    } catch (error) {
      rows.push({
        id: entry.id,
        status: "fail",
        detail: error instanceof Error ? error.message : "Unknown handshake failure.",
      });
    }
  }

  printSection("Conformance");
  for (const row of rows) {
    const marker = row.status === "pass" ? chalk.green("PASS") : row.status === "skip" ? chalk.yellow("SKIP") : chalk.red("FAIL");
    console.log(`${marker} ${row.id.padEnd(24)} ${row.detail}`);
  }

  const failed = rows.filter((row) => row.status === "fail").length;
  const skipped = rows.filter((row) => row.status === "skip").length;
  console.log(chalk.gray(`\n${rows.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed.`));
  if (failed > 0) process.exitCode = 1;
}

async function runStdioHandshake(distPath: string, timeoutMs: number): Promise<number> {
  const child = spawn(process.execPath, [distPath, "--transport", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    windowsHide: IS_WINDOWS,
  });

  let buffer = "";
  let stderr = "";
  const pendingResponses = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timeout: NodeJS.Timeout }>();

  const waitForResponse = (id: number): Promise<unknown> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResponses.delete(id);
      reject(new Error(`Timed out waiting for response ${id}.`));
    }, timeoutMs);
    pendingResponses.set(id, { resolve, reject, timeout });
  });

  const failPendingResponses = (reason: Error): void => {
    for (const pending of pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    pendingResponses.clear();
  };

  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: unknown };
        if (typeof parsed.id !== "number") continue;
        const pending = pendingResponses.get(parsed.id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        pendingResponses.delete(parsed.id);
        if (parsed.error !== undefined) {
          pending.reject(new Error(JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result);
        }
      } catch {
        // Servers may emit non-JSON diagnostics on stdout; ignore them here.
      }
    }
  });

  child.once("exit", (code) => {
    if (code !== 0) {
      failPendingResponses(new Error(`Server exited before completing handshake (code ${code ?? 1}). ${stderr.slice(0, 300)}`));
    }
  });
  child.once("error", (error) => failPendingResponses(error));

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "umt-conformance", version: CLI_VERSION },
    },
  }) + "\n");
  const initResponse = waitForResponse(1);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  const toolsResponsePromise = waitForResponse(2);

  await initResponse;
  const toolsResponse = await toolsResponsePromise;
  child.kill();

  if (toolsResponse && typeof toolsResponse === "object" && "tools" in toolsResponse) {
    return (toolsResponse as { tools: unknown[] }).tools.length;
  }

  throw new Error("tools/list response did not contain a tools array.");
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
    version: CLI_VERSION,
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
  const spinner = (await oraLazy(`Activating profile '${name}'`)).start();

  const entries = profile.serverIds.map((id) => getRegistryEntry(id));
  const generatedConfig = createGeneratedConfig(entries, profile.mode);
  await writeGeneratedConfig(profile.outputPath, generatedConfig);
  spinner.succeed(`Applied profile '${name}' to ${profile.outputPath}`);
}

async function runProfileDelete(name: string): Promise<void> {
  await deleteProfile(name);
  console.log(chalk.green(`Deleted profile '${name}'.`));
}

/**
 * Rename an existing profile by loading it, saving under the new name,
 * and deleting the old one.
 */
async function runProfileRename(oldName: string, newName: string): Promise<void> {
  try {
    const profile = await loadProfile(oldName);
    const renamed = { ...profile, name: newName };
    await saveNamedProfile(renamed);
    await deleteProfile(oldName);
    console.log(chalk.green(`Renamed profile '${oldName}' to '${newName}'.`));
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

/**
 * Duplicate an existing profile under a new name.
 */
async function runProfileDuplicate(source: string, target: string): Promise<void> {
  try {
    const profile = await loadProfile(source);
    const duplicated = { ...profile, name: target, createdAt: new Date().toISOString() };
    await saveNamedProfile(duplicated);
    console.log(chalk.green(`Duplicated profile '${source}' as '${target}'.`));
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = new Command();

  // Check for updates concurrently with command dispatch instead of awaiting
  // it up front: the check is best-effort, and on a cold cache (or an
  // unreachable registry) it can otherwise add seconds — up to the 5s fetch
  // timeout — to every CLI invocation. The notification is printed after the
  // command output instead of before.
  const updateNotificationPromise = checkForUpdate(CLI_VERSION, argv).catch(() => null);

  program
    .name("universal-mcp-toolkit")
    .description("A polished control plane for the universal-mcp-toolkit MCP server monorepo.")
    .version(CLI_VERSION)
    .option("--no-update-check", "Disable the automatic update check on startup.");

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

  // --- `umt tools` subcommand group -----------------------------------------

  const toolsCmd = program
    .command("tools")
    .description("Discover and inspect MCP tools exposed by servers in the toolkit.");

  toolsCmd
    .command("list")
    .description("List all tools exposed by one or more servers, with optional filtering.")
    .option("-s, --server <serverIds...>", "Filter to specific server IDs.")
    .option("-q, --query <query>", "Filter tools by name or description (case-insensitive substring).")
    .option("--json", "Print the tool listing as JSON instead of a table.")
    .option("--slim", "Connect to each server and print a slim manifest: tool names + one-line descriptions grouped by server, with token savings vs full schemas.")
    .action(async (options: { server?: string[]; query?: string; json?: boolean; slim?: boolean }) => {
      // Start with the full registry, optionally filtered by server IDs.
      let filtered = SERVER_REGISTRY;
      if (options.server?.length) {
        filtered = SERVER_REGISTRY.filter((e) => options.server!.includes(e.id));
      }

      // Slim catalog mode: fetch live tools/lists and render the cheap
      // names-only manifest instead of the static registry names.
      if (options.slim) {
        const {
          buildSlimManifest,
          formatSlimManifest,
          compareManifestSize,
        } = await import("@universal-mcp-toolkit/bridge");
        const perServer: Array<{ server: string; tools: BridgeTool[] }> = [];
        const skipped: Array<{ server: string; reason: string }> = [];
        const spinner = (await oraLazy("Connecting to servers...")).start();
        for (const entry of filtered) {
          let bridge: { listTools(): Promise<{ tools: BridgeTool[] }>; disconnect(): Promise<void> } | undefined;
          try {
            bridge = await connectBridgeToEntry(entry);
            const listing = await bridge.listTools();
            perServer.push({ server: entry.id, tools: listing.tools });
            spinner.text = `Connecting to servers... (${perServer.length} ok)`;
          } catch (error) {
            skipped.push({
              server: entry.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await bridge?.disconnect().catch(() => undefined);
          }
        }
        spinner.stop();

        const manifest = buildSlimManifest(perServer);
        if (manifest.totalTools === 0) {
          console.log(chalk.yellow("No tools found. All servers failed to connect or expose tools."));
        } else {
          console.log(formatSlimManifest(manifest));
          console.log();
          let fullTokens = 0;
          let slimTokens = 0;
          for (const s of perServer) {
            const c = compareManifestSize(s.tools, s.server);
            fullTokens += c.fullTokens;
            slimTokens += c.slimTokens;
          }
          const pct = fullTokens === 0 ? 0 : Math.round(((fullTokens - slimTokens) / fullTokens) * 100);
          console.log(
            chalk.gray(
              `${manifest.totalTools} tool(s) across ${manifest.servers.length} server(s) · ` +
              `~${fullTokens} tokens (full schemas) vs ~${slimTokens} tokens (slim) — ${pct}% smaller`,
            ),
          );
        }
        for (const s of skipped) {
          console.log(chalk.yellow(`Skipped ${s.server}: ${s.reason}`));
        }
        return;
      }

      // Build a flat list of { serverId, toolName, title?, description? } rows.
      // Only servers that declare toolNames contribute rows; servers with an
      // empty toolNames array (e.g. remote MCP servers) are skipped here
      // because we can't know their tools without connecting.
      const rows: Array<{ serverId: string; toolName: string; title?: string; description?: string }> = [];
      for (const entry of filtered) {
        for (const toolName of entry.toolNames) {
          rows.push({ serverId: entry.id, toolName });
        }
      }

      // Apply the query filter (case-insensitive substring on tool name).
      if (options.query) {
        const lower = options.query.toLowerCase();
        // Only filter if there are rows to filter
        const queryRows = rows.filter((r) => r.toolName.toLowerCase().includes(lower));
        if (queryRows.length > 0) {
          // Replace rows with filtered set
          rows.length = 0;
          rows.push(...queryRows);
        }
      }

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(chalk.yellow("No tools found matching the given criteria."));
        return;
      }

      console.log(`Found ${chalk.bold(rows.length)} tool(s) across ${filtered.length} server(s).\n`);
      console.log(renderToolTable(rows));
    });

  toolsCmd
    .command("describe")
    .description("Show the full input schema for one tool — on-demand expansion of the slim catalog.")
    .argument("<toolName>", "Exact tool name to describe.")
    .option("-s, --server <serverId>", "Server ID to query. Required when several servers declare the tool.")
    .option("--json", "Print the full tool schema as JSON instead of formatted text.")
    .action(async (toolName: string, options: { server?: string; json?: boolean }) => {
      // Resolve which server declares the tool.
      let entry: ServerRegistryEntry;
      if (options.server) {
        entry = getRegistryEntry(options.server);
        if (!entry.toolNames.includes(toolName)) {
          console.log(
            chalk.yellow(
              `Warning: server '${entry.id}' does not declare '${toolName}' in the registry; querying it anyway.`,
            ),
          );
        }
      } else {
        const candidates = findServersDeclaringTool(toolName);
        if (candidates.length === 0) {
          console.error(chalk.red(`No server in the registry declares a tool named '${toolName}'.`));
          process.exitCode = 1;
          return;
        }
        if (candidates.length > 1) {
          console.error(
            chalk.red(
              `Tool '${toolName}' is declared by several servers (${candidates.map((c) => c.id).join(", ")}). ` +
              "Re-run with --server <id>.",
            ),
          );
          process.exitCode = 1;
          return;
        }
        entry = candidates[0]!;
      }

      const { describeTool } = await import("@universal-mcp-toolkit/bridge");
      const spinner = (await oraLazy(`Connecting to ${entry.title}...`)).start();
      let bridge: { listTools(): Promise<{ tools: BridgeTool[] }>; disconnect(): Promise<void> } | undefined;
      try {
        bridge = await connectBridgeToEntry(entry);
        const listing = await bridge.listTools();
        spinner.succeed(`Connected to ${entry.title}.`);
        const detail = describeTool(listing.tools, toolName, entry.id);
        if (options.json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }
        printSection(`Tool: ${detail.name}`);
        if (detail.title) console.log(`${chalk.bold("Title:")} ${detail.title}`);
        console.log(`${chalk.bold("Server:")} ${detail.server}`);
        if (detail.description) console.log(`${chalk.bold("Description:")} ${detail.description}`);
        console.log(chalk.bold("Input schema:"));
        console.log(JSON.stringify(detail.inputSchema, null, 2));
      } catch (error) {
        spinner.fail(`Failed to describe tool '${toolName}'.`);
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      } finally {
        await bridge?.disconnect().catch(() => undefined);
      }
    });

  toolsCmd
    .command("call")
    .description("Call a tool on a server — with MRTR multi-round-trip support and optional task execution.")
    .argument("<toolName>", "Tool to call.")
    .option("-s, --server <serverId>", "Server ID to query. Required when several servers declare the tool.")
    .option("--args <json>", "Tool arguments as a JSON object.", "{}")
    .option("--task", "Run as a long-running task (2026-07-28 Tasks): spawn, stream progress, await completion.")
    .option("--task-ttl <ms>", "Requested task retention in ms.")
    .option("--task-poll <ms>", "Poll interval hint in ms.")
    .option("--max-rounds <n>", "MRTR round cap — how many input_required rounds to answer (default 8).", "8")
    .option("--json", "Print the result as JSON instead of formatted text.")
    .action(async (toolName: string, options: {
      server?: string; args: string; task?: boolean; taskTtl?: string;
      taskPoll?: string; maxRounds: string; json?: boolean;
    }) => {
      let entry: ServerRegistryEntry;
      try {
        entry = resolveToolEntry(toolName, options.server);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
        return;
      }
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = parseToolArgsJson(options.args);
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
        return;
      }

      const { watchDefinitionDrift } = await import("./task-cli.js");
      const spinner = (await oraLazy(`Connecting to ${entry.title}...`)).start();
      let bridge: Awaited<ReturnType<typeof connectBridgeToEntry>> | undefined;
      try {
        bridge = await connectBridgeToEntry(entry);
        spinner.succeed(`Connected to ${entry.title}.`);
        const stopWatching = watchDefinitionDrift(bridge, entry.id);
        try {
          await refreshToolListingForDriftCheck(bridge, entry);
          if (options.task) {
            await runToolAsTask(bridge, entry, toolName, toolArgs, options);
          } else {
            const result = await bridge.callToolWithMrtr(
              toolName,
              toolArgs,
              {
                maxRounds: Math.max(1, parseInt(options.maxRounds, 10) || 8),
                onInputRequest: collectMrtrInputs,
              },
            );
            printToolResult(toolName, result, options.json);
          }
        } finally {
          stopWatching();
        }
      } catch (error) {
        spinner.fail(`Failed to call tool '${toolName}'.`);
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      } finally {
        await bridge?.disconnect().catch(() => undefined);
      }
    });

  // --- `umt task` — 2026-07-28 Tasks: spawn / status / await / cancel --------

  const taskCmd = program
    .command("task")
    .description("Manage long-running MCP tasks (2026-07-28 Tasks extension: spawn, poll, await, cancel).");

  taskCmd
    .command("spawn")
    .description("Spawn a long-running tool call as a task and print its task ID.")
    .argument("<toolName>", "Tool to call.")
    .requiredOption("-s, --server <serverId>", "Server ID to run against.")
    .option("--args <json>", "Tool arguments as a JSON object.", "{}")
    .option("--ttl <ms>", "Requested task retention in ms.")
    .option("--poll <ms>", "Poll interval hint in ms.")
    .option("--json", "Print the spawn result as JSON.")
    .action(async (toolName: string, options: {
      server: string; args: string; ttl?: string; poll?: string; json?: boolean;
    }) => {
      await withTaskBridge(options.server, async (bridge, entry) => {
        const support = bridge.getTaskSupport();
        if (!support.toolsCallTasks) {
          console.error(
            chalk.red(
              `Server '${entry.id}' does not advertise task support for tools/call ` +
              "(2026-07-28 Tasks extension). Use `umt tools call` for a direct call instead.",
            ),
          );
          process.exitCode = 1;
          return;
        }
        const toolArgs = parseToolArgsJson(options.args);
        const spawned = await bridge.spawnTaskToolCall(toolName, toolArgs, {
          ...(options.ttl !== undefined ? { ttlMs: parseInt(options.ttl, 10) } : {}),
          ...(options.poll !== undefined ? { pollIntervalMs: parseInt(options.poll, 10) } : {}),
        });
        if (options.json) {
          console.log(JSON.stringify(spawned, null, 2));
          return;
        }
        if (spawned.result) {
          console.log(chalk.gray("The server executed synchronously — no task was created."));
          printToolResult(toolName, spawned.result, false);
          return;
        }
        console.log(`Task spawned: ${chalk.bold(spawned.taskId)}`);
        console.log(`Status: ${spawned.task?.status}`);
        console.log(chalk.gray(`Follow it with: umt task await ${spawned.taskId} --server ${entry.id}`));
      });
    });

  taskCmd
    .command("status")
    .description("Show the current status of a task.")
    .argument("<taskId>", "Task ID from `umt task spawn`.")
    .requiredOption("-s, --server <serverId>", "Server ID the task belongs to.")
    .option("--json", "Print the task status as JSON.")
    .action(async (taskId: string, options: { server: string; json?: boolean }) => {
      await withTaskBridge(options.server, async (bridge) => {
        const task = await bridge.getTask(taskId);
        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        printSection(`Task: ${task.taskId}`);
        console.log(`${chalk.bold("Status:")} ${task.status}`);
        if (task.statusMessage) console.log(`${chalk.bold("Message:")} ${task.statusMessage}`);
        console.log(`${chalk.bold("Created:")} ${task.createdAt}`);
        console.log(`${chalk.bold("Updated:")} ${task.lastUpdatedAt}`);
        if (task.pollInterval !== undefined) console.log(`${chalk.bold("Poll interval:")} ${task.pollInterval}ms`);
      });
    });

  taskCmd
    .command("await")
    .description("Poll a task until it completes, streaming progress updates.")
    .argument("<taskId>", "Task ID from `umt task spawn`.")
    .requiredOption("-s, --server <serverId>", "Server ID the task belongs to.")
    .option("--timeout <ms>", "Give up after this many ms.")
    .option("--poll <ms>", "Poll interval in ms when the server advertises none (default 1000).")
    .option("--json", "Print the final result as JSON.")
    .action(async (taskId: string, options: {
      server: string; timeout?: string; poll?: string; json?: boolean;
    }) => {
      await withTaskBridge(options.server, async (bridge) => {
        const spinner = (await oraLazy(`Waiting for task ${taskId}...`)).start();
        try {
          const result = await bridge.awaitTaskCompletion(taskId, {
            ...(options.timeout !== undefined ? { timeoutMs: parseInt(options.timeout, 10) } : {}),
            ...(options.poll !== undefined ? { pollIntervalMs: parseInt(options.poll, 10) } : {}),
            onProgress: (task) => {
              spinner.text = `Task ${taskId}: ${task.status}${task.statusMessage ? ` — ${task.statusMessage}` : ""}`;
            },
          });
          spinner.succeed(`Task ${taskId} completed.`);
          printToolResult(`task:${taskId}`, result, options.json);
        } catch (error) {
          spinner.fail(`Task ${taskId} did not complete.`);
          throw error;
        }
      });
    });

  taskCmd
    .command("cancel")
    .description("Cancel a task (cascades to linked child tasks by default).")
    .argument("<taskId>", "Task ID from `umt task spawn`.")
    .requiredOption("-s, --server <serverId>", "Server ID the task belongs to.")
    .option("--no-cascade", "Cancel only this task, not linked children.")
    .action(async (taskId: string, options: { server: string; cascade: boolean }) => {
      await withTaskBridge(options.server, async (bridge) => {
        await bridge.cancelTask(taskId, { cascade: options.cascade });
        console.log(
          chalk.green(`Task ${taskId} cancelled${options.cascade ? " (cascade)" : ""}.`),
        );
      });
    });

  // --- `umt workflow` — validate and run deterministic workflows ------------

  const workflowCmd = program
    .command("workflow")
    .description("Validate and run sequential JSON MCP workflows.");

  workflowCmd
    .command("validate")
    .description("Validate a workflow JSON file without running it.")
    .argument("<file>", "Path to the workflow JSON file.")
    .action(async (file: string) => {
      const workflowPath = path.resolve(file);
      let source: string;
      try {
        source = await readFile(workflowPath, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read workflow file '${workflowPath}': ${detail}`);
      }

      const workflow = parseWorkflowJson(source, workflowPath);
      console.log(chalk.green(`Valid workflow '${workflow.name}' (${workflow.steps.length} step(s)).`));
    });

  workflowCmd
    .command("run")
    .description("Run a validated workflow sequentially.")
    .argument("<file>", "Path to the workflow JSON file.")
    .option("--input <json>", "Workflow input values as a JSON object.", "{}")
    .option("--trace", "Record a turn-scoped trace of every tool call; saves JSON and prints a summary.")
    .option("--trace-model <model>", "Model used for cost estimation (default: gpt-4o or $UMT_TRACE_MODEL).")
    .action(async (file: string, options: { input: string; trace?: boolean; traceModel?: string }) => {
      const workflowPath = path.resolve(file);
      let source: string;
      try {
        source = await readFile(workflowPath, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read workflow file '${workflowPath}': ${detail}`);
      }

      const workflow = parseWorkflowJson(source, workflowPath);
      let inputs: unknown;
      try {
        inputs = JSON.parse(options.input) as unknown;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`--input must be valid JSON: ${detail}`);
      }
      if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
        throw new Error("--input must be a JSON object.");
      }

      const { MCPFunctionCallingBridge, startTrace } = await import("@universal-mcp-toolkit/bridge");
      const { resolveTraceModel, saveTrace } = await import("./trace.js");
      const trace = options.trace ? startTrace({ model: resolveTraceModel(options.traceModel) }) : undefined;
      const result = await executeWorkflow(workflow, inputs as Record<string, unknown>, {
        createBridge: async (serverId) => {
          const entry = getRegistryEntry(serverId);
          const config = await resolveBridgeConfig(entry);
          return new MCPFunctionCallingBridge(config, trace ? { tracing: { trace, server: serverId } } : {});
        },
      });
      console.log(JSON.stringify(result, null, 2));
      if (trace) {
        const finished = trace.endTrace();
        const tracePath = await saveTrace(trace, finished);
        console.log(chalk.gray(`\nTrace saved to ${tracePath}`));
        console.log(trace.formatSummary(finished));
      }
    });

  // --- `umt compose` — pipe tool outputs between MCP servers -----------------

  program
    .command("compose")
    .description(
      "Call a tool on one MCP server and pipe its output into a tool on another " +
      "server. Specify as: --from <server1:tool1> --to <server2:tool2> --args '{\"param\": \"value\"}'.",
    )
    .option("-f, --from <spec>", "Source tool as 'serverId:toolName'.", (v: string) => v)
    .option("-t, --to <spec>", "Destination tool as 'serverId:toolName'.", (v: string) => v)
    .option("-a, --args <json>", "JSON arguments for the source tool.", (v: string) => v)
    .option("--from-args <json>", "JSON arguments specifically for the source tool.")
    .option("--to-args <json>", "JSON arguments for the destination tool. Use \"__PIPE__\" to receive the source output.")
    .option("--trace", "Record a turn-scoped trace of both tool calls; saves JSON and prints a summary.")
    .option("--trace-model <model>", "Model used for cost estimation (default: gpt-4o or $UMT_TRACE_MODEL).")
    .action(async (options: {
      from?: string;
      to?: string;
      args?: string;
      fromArgs?: string;
      toArgs?: string;
      trace?: boolean;
      traceModel?: string;
    }) => {
      if (!options.from || !options.to) {
        console.error(chalk.red("Both --from and --to are required."));
        console.log(chalk.gray("  Example:"));
        console.log(chalk.gray("    umt compose \\"));
        console.log(chalk.gray("      --from github:search_repositories --args '{\"query\":\"mcp\"}' \\"));
        console.log(chalk.gray("      --to notion:get_page --to-args '{\"page_id\":\"__PIPE__\"}'"));
        process.exit(1);
      }

      // Parse "serverId:toolName" specs.
      const [fromServerId, fromTool] = options.from.split(":");
      const [toServerId, toTool] = options.to.split(":");

      if (!fromServerId || !fromTool || !toServerId || !toTool) {
        console.error(chalk.red("Invalid format. Use 'serverId:toolName' (e.g. github:search_repositories)."));
        process.exit(1);
      }

      // Gather configs for both servers.
      const fromEntry = getRegistryEntry(fromServerId);
      const toEntry = getRegistryEntry(toServerId);

      const { MCPFunctionCallingBridge, startTrace } = await import("@universal-mcp-toolkit/bridge");
      const { resolveTraceModel, saveTrace } = await import("./trace.js");
      const trace = options.trace ? startTrace({ model: resolveTraceModel(options.traceModel) }) : undefined;

      // Build configs from the registry entries.
      const fromConfig = await resolveBridgeConfig(fromEntry);
      const toConfig = await resolveBridgeConfig(toEntry);

      // Connect to the source server.
      const fromBridge = new MCPFunctionCallingBridge(
        fromConfig,
        trace ? { tracing: { trace, server: fromServerId } } : {},
      );
      await fromBridge.connect();

      const fromArgs = options.fromArgs ? JSON.parse(options.fromArgs) :
                       options.args ? JSON.parse(options.args) : {};

      console.log(chalk.cyan(`→ Calling ${fromServerId}:${fromTool} ...`));
      const fromResult = await fromBridge.callTool(fromTool, fromArgs);
      await fromBridge.disconnect();

      if (fromResult.error) {
        console.error(chalk.red(`Source tool failed: ${fromResult.output}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Source returned ${fromResult.output.length} characters`));

      // Connect to the destination server.
      const toBridge = new MCPFunctionCallingBridge(
        toConfig,
        trace ? { tracing: { trace, server: toServerId } } : {},
      );
      await toBridge.connect();

      // Parse the destination args, substituting __PIPE__ with the source output.
      let toArgs: Record<string, unknown>;
      if (options.toArgs) {
        const raw = JSON.parse(options.toArgs) as Record<string, unknown>;
        toArgs = substitutePipe(raw, fromResult.output) as Record<string, unknown>;
      } else if (options.args) {
        toArgs = JSON.parse(options.args);
      } else {
        toArgs = {};
      }

      console.log(chalk.cyan(`→ Calling ${toServerId}:${toTool} with piped input ...`));
      const toResult = await toBridge.callTool(toTool, toArgs);
      await toBridge.disconnect();

      console.log(chalk.bold("\n=== Result ==="));
      console.log(toResult.output);

      if (trace) {
        const finished = trace.endTrace();
        const tracePath = await saveTrace(trace, finished);
        console.log(chalk.gray(`\nTrace saved to ${tracePath}`));
        console.log(trace.formatSummary(finished));
      }
    });

  // --- `umt discover` — scan for MCP servers with well-known manifests -----

  program
    .command("discover")
    .description(
      "Scan local node_modules and npx for MCP servers with well-known manifests " +
      "(.well-known/mcp-server.json). Lists discovered servers not in the built-in registry. " +
      "Use --remote + --url for direct HTTP discovery or --registry for an MCP Registry endpoint.",
    )
    .option("-d, --dir <path>", "Directory to scan for installed packages (default: current directory).")
    .option("--json", "Print discovered servers as JSON.")
    .option("--remote", "Discover remote MCP servers over HTTP by fetching .well-known/mcp-server.json from URLs.")
    .option("--url <urls...>", "Comma-separated list of URLs to check for remote MCP server manifests (requires --remote).")
    .option("--registry [url]", `Include MCP Registry entries (default: ${DEFAULT_MCP_REGISTRY_URL}).`)
    .action(async (options: {
      dir?: string;
      json?: boolean;
      remote?: boolean;
      url?: string | string[];
      registry?: boolean | string;
    }) => {
      // --- Local discovery (existing behavior) ---
      const scanDir = path.resolve(options.dir ?? process.cwd());
      const nodeModulesDir = path.join(scanDir, "node_modules");
      const discovered: Array<{ name: string; path: string; manifest: any }> = [];

      if (existsSync(nodeModulesDir)) {
        try {
          const packages = await readdir(nodeModulesDir);
          for (const pkg of packages) {
            if (pkg.startsWith("@")) {
              const scopeDir = path.join(nodeModulesDir, pkg);
              const scopedPkgs = await readdir(scopeDir).catch(() => []);
              for (const subPkg of scopedPkgs) {
                const pkgPath = path.join(scopeDir, subPkg);
                await checkPackage(pkgPath, pkg, subPkg, discovered);
              }
              continue;
            }
            const pkgPath = path.join(nodeModulesDir, pkg);
            await checkPackage(pkgPath, "", pkg, discovered);
          }
        } catch (error) {
          console.error(chalk.red(`Error scanning for MCP servers: ${error instanceof Error ? error.message : error}`));
          process.exit(1);
        }
      } else {
        console.log(chalk.gray(`No node_modules found at ${nodeModulesDir}. Nothing to discover locally.`));
      }

      // --- Remote discovery (new behavior) ---
      if (options.remote) {
        const urls = options.url
          ? (Array.isArray(options.url) ? options.url : [options.url])
              .flatMap((value) => value.split(","))
              .map((url) => url.trim())
              .filter(Boolean)
          : [];

        if (urls.length === 0) {
          console.log(chalk.yellow("--remote was set but no --url values provided. Skipping remote discovery."));
        } else {
          console.log(chalk.gray(`Checking ${urls.length} remote URL(s) for MCP server manifests...`));
          for (const url of urls) {
            // Strip trailing slashes without regex to avoid polynomial ReDoS (CodeQL alert #7)
            let trimmedUrl = url;
            while (trimmedUrl.endsWith("/")) {
              trimmedUrl = trimmedUrl.slice(0, -1);
            }
            const manifestUrl = trimmedUrl + "/.well-known/mcp-server.json";
            try {
              const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) });
              if (res.ok) {
                const manifest = await res.json();
                const name = manifest.name ?? new URL(url).hostname;
                // Mark remote discoveries distinctly so they can be merged
                // with local results without confusion.
                discovered.push({
                  name: name,
                  path: url,
                  manifest: { ...manifest, _remote: url, _source: "remote" },
                });
                if (!options.json) {
                  console.log(chalk.green(`  ✓ Found remote MCP server: ${name} (${url})`));
                }
              } else if (!options.json) {
                console.log(chalk.gray(`  ✗ No manifest at ${manifestUrl} (HTTP ${res.status})`));
              }
            } catch (error) {
              if (!options.json) {
                console.log(chalk.gray(`  ✗ Failed to fetch ${manifestUrl}: ${error instanceof Error ? error.message : error}`));
              }
            }
          }
        }
      }

      // --- MCP Registry discovery ---
      if (options.registry) {
        const registryUrl = typeof options.registry === "string"
          ? options.registry
          : DEFAULT_MCP_REGISTRY_URL;
        try {
          const registryServers = await fetchRegistryServers(registryUrl);
          for (const entry of registryServers) {
            discovered.push({
              name: entry.server.name,
              path: registryUrl,
              manifest: {
                ...entry.server,
                _meta: entry._meta,
                _registry: registryUrl,
                _source: "registry",
              },
            });
          }
          if (!options.json) {
            console.log(chalk.green(`  ✓ Found ${registryServers.length} MCP Registry server entr${registryServers.length === 1 ? "y" : "ies"}.`));
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(chalk.yellow(`MCP Registry discovery failed: ${detail} Local and remote results are still available.`));
        }
      }

      // --- Output ---
      if (discovered.length === 0) {
        console.log(chalk.yellow("No MCP servers with .well-known/mcp-server.json discovered."));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(discovered, null, 2));
        return;
      }

      console.log(chalk.bold(`\nDiscovered ${discovered.length} MCP server(s):\n`));
      for (const item of discovered) {
        const source = item.manifest?._source;
        const label = source === "remote"
          ? `${chalk.cyan(item.name)} ${chalk.gray("(remote")}`
          : source === "registry"
            ? `${chalk.cyan(item.name)} ${chalk.gray("(registry")}`
            : `${chalk.cyan(item.name)} ${chalk.gray("→")}`;
        console.log(`${label} ${source === "remote" || source === "registry" ? `${item.path})` : item.path}`);
        if (item.manifest?.description) {
          console.log(`  ${chalk.gray(item.manifest.description)}`);
        }
        if (Array.isArray(item.manifest?.tools)) {
          console.log(`  ${chalk.magenta("Tools:")} ${item.manifest.tools.map((t: any) => t.name).join(", ")}`);
        }
        console.log("");
      }
    });

  /**
   * Check a package directory for a .well-known/mcp-server.json manifest.
   */
  async function checkPackage(
    pkgPath: string,
    scope: string,
    pkgName: string,
    discovered: Array<{ name: string; path: string; manifest: any }>,
  ): Promise<void> {
    const manifestPath = path.join(pkgPath, ".well-known", "mcp-server.json");
    if (await pathExists(manifestPath)) {
      try {
        const manifestContent = await readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);
        const fullName = scope ? `${scope}/${pkgName}` : pkgName;
        discovered.push({ name: fullName, path: pkgPath, manifest });
      } catch {
        // Malformed JSON — skip.
      }
    }
  }

  program
    .command("config")
    .description("Generate a host configuration snippet for one or more servers.")
    .option("-s, --server <serverIds...>", "Server IDs to include.")
    .option("-t, --target <targets>", "Config target: claude-desktop, cursor, or json. Supports comma-separated list.")
    .option("-m, --mode <mode>", "Invocation mode: npx or workspace.", "npx")
    .option("-w, --write <path>", "Write the config to a file instead of stdout.")
    .action(async (options: { mode: InvocationMode; server?: string[]; target?: string; write?: string }) => {
      const serverIds = options.server?.length ? options.server : await promptForServers();
      
      // Support comma-separated targets (e.g. "claude-desktop,cursor")
      const targets = options.target
        ? options.target.split(",").map(t => t.trim() as ConfigTarget)
        : [await promptForTarget()];
      
      for (const target of targets) {
        if (targets.length > 1) {
          console.log(chalk.bold(`\n=== ${target} ===`));
        }
        await generateConfig(serverIds, target, options.mode, options.write);
      }
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

      const spinner = (await oraLazy(`Writing ${target} config`)).start();
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
    .option("--transport <transport>", "stdio, sse, or streamable-http", "stdio")
    .option("--host <host>", "Host for SSE mode.", "127.0.0.1")
    .option("--port <port>", "Port for SSE mode.", "3333")
    .option("--supervise", "Enable auto-restart on crash with crash loop detection.")
    .option("--log-level <level>", "Log level: debug, info, warn, error.", "info")
    .action(async (serverId: string, options: { host: string; port: string; transport: "sse" | "stdio" | "streamable-http"; supervise?: boolean; logLevel?: string }) => {
      await runServer(serverId, options.transport, options.host, Number.parseInt(options.port, 10), options.supervise, options.logLevel);
    });

  program
    .command("doctor")
    .description("Check build outputs and required environment variables.")
    .argument("[serverId]", "Optionally scope the checks to one server.")
    .option("--fix", "Attempt to auto-heal common issues (build missing dist, write env vars).")
    .option("--vet", "Also live-vet the scoped server (or every `umt add`-registered server): MCP spec-conformance + security scan.")
    .action(async (serverId?: string, options?: { fix?: boolean; vet?: boolean }) => {
      await runDoctor(serverId, options?.fix, options?.vet);
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
    .command("conformance")
    .description("Check registry config generation and live stdio handshakes where build output exists.")
    .argument("[serverId]", "Optionally scope the conformance check to one server.")
    .action(async (serverId?: string) => {
      await runConformance(serverId);
    });

  program
    .command("vet")
    .description("Live-vet a running MCP server: protocol negotiation, tool-poisoning scan, permission-risk tiering, drift pin. Exit 0 clean, 1 security findings, 2 protocol error.")
    .argument("<server-id-or-url>", "Registry server ID or http(s) URL of the running server.")
    .option("--json", "Print the machine-readable report instead of human-readable text.")
    .action(async (target: string, options: { json?: boolean }) => {
      const { runVet } = await import("./vet.js");
      const spinner = (await oraLazy(`Vetting ${target}…`)).start();
      try {
        const exitCode = await runVet(await resolveVetTarget(target), options);
        spinner.stop();
        if (exitCode !== 0) process.exitCode = exitCode;
      } catch (error) {
        spinner.fail("Vet failed");
        throw error;
      }
    });

  program
    .command("add")
    .description("Register a server with UMT (for `doctor --vet`), with a non-blocking vet advisory first.")
    .argument("<server-id-or-url>", "Registry server ID or http(s) URL of the running server.")
    .option("--skip-vet", "Skip the vet advisory and register immediately.")
    .option("--json", "Print the machine-readable result instead of human-readable text.")
    .action(async (target: string, options: { skipVet?: boolean; json?: boolean }) => {
      const { runAdd } = await import("./vet.js");
      const spinner = options.skipVet ? undefined : (await oraLazy(`Vetting ${target} (advisory)…`)).start();
      try {
        await runAdd(await resolveVetTarget(target), target, options);
        spinner?.stop();
      } catch (error) {
        spinner?.fail("Add failed");
        throw error;
      }
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

  profileCmd
    .command("rename")
    .description("Rename an existing profile.")
    .argument("<oldName>", "The current profile name.")
    .argument("<newName>", "The new profile name.")
    .action(async (oldName: string, newName: string) => {
      await runProfileRename(oldName, newName);
    });

  profileCmd
    .command("duplicate")
    .description("Duplicate an existing profile under a new name.")
    .argument("<source>", "The profile name to duplicate.")
    .argument("<target>", "The new profile name.")
    .action(async (source: string, target: string) => {
      await runProfileDuplicate(source, target);
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
    .option("--grep <pattern>", "Filter log lines matching the given pattern.")
    .action(async (serverName: string, options: { lines: string; follow?: boolean; grep?: string }) => {
      await runLogs(serverName, parseInt(options.lines, 10), !!options.follow, options.grep);
    });

  program
    .command("upgrade")
    .description("Check npm registry for newer versions and upgrade.")
    .option("--all", "Upgrade all packages without prompting.")
    .option("--dry-run", "Show what would change without making modifications.")
    .argument("[serverName]", "Specific server to upgrade.")
    .action(async (serverName: string | undefined, options: { all?: boolean; dryRun?: boolean }) => {
      await runUpgrade(options.all ?? false, serverName, options.dryRun);
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
    .action(async (memos: string | undefined, options: { dbPath?: string }) => {
      await runLinkMemos(options.dbPath);
    });

  profileCmd
    .command("create")
    .description("Create a new named profile with interactive wizard.")
    .argument("<name>", "Profile name.")
    .action(async (name: string) => {
      await runProfileCreate(name);
    });

  profileCmd
    .command("show")
    .description("Show profile configuration.")
    .argument("[name]", "Profile name (shows active if not provided).")
    .action(async (name?: string) => {
      await runProfileShow(name);
    });

  profileCmd
    .command("export")
    .description("Export a profile as a portable JSON file.")
    .argument("<name>", "Profile name.")
    .option("--output <path>", "Output file path.")
    .action(async (name: string, options: { output?: string }) => {
      await runProfileExport(name, options.output);
    });

  profileCmd
    .command("import")
    .description("Import a profile from a JSON file.")
    .argument("<path>", "Path to profile JSON file.")
    .action(async (profilePath: string) => {
      await runProfileImport(profilePath);
    });

  // --- `umt trace` — inspect saved turn-scoped traces -----------------------

  const traceCmd = program
    .command("trace")
    .description("Inspect turn-scoped tool-call traces recorded with --trace.");

  traceCmd
    .command("list")
    .description("List saved traces (newest first).")
    .option("--json", "Print the trace summaries as JSON.")
    .action(async (options: { json?: boolean }) => {
      const { listTraces, renderTraceTable } = await import("./trace.js");
      const summaries = await listTraces();
      if (summaries.length === 0) {
        console.log(chalk.yellow("No saved traces. Run a command with --trace to record one."));
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(summaries, null, 2));
        return;
      }
      console.log(renderTraceTable(summaries));
    });

  traceCmd
    .command("show")
    .description("Show a saved trace: human-readable summary, JSON, or OTEL export.")
    .argument("<id>", "Trace ID (prefix match allowed).")
    .option("--json", "Print the raw trace JSON (privacy-safe: sizes only, never bodies).")
    .option("--otel", "Print the OpenTelemetry OTLP-compatible JSON export.")
    .action(async (id: string, options: { json?: boolean; otel?: boolean }) => {
      const { loadTrace } = await import("./trace.js");
      const loaded = await loadTrace(id);
      if (!loaded) {
        console.error(chalk.red(`No saved trace matching '${id}'.`));
        process.exit(1);
      }
      if (options.json) {
        console.log(loaded.json);
        return;
      }
      // toOtelJson/formatSummary only read the finished payload, so a fresh
      // ActiveTrace works as a stateless formatter here.
      const { ActiveTrace } = await import("@universal-mcp-toolkit/bridge");
      const formatter = new ActiveTrace();
      if (options.otel) {
        console.log(formatter.toOtelJson(loaded.trace));
        return;
      }
      console.log(formatter.formatSummary(loaded.trace));
    });

  // --- `umt skills` — Agent Skills interop -----------------------------------
  // Skills carry workflow knowledge (when/how); MCP servers stay narrow
  // (execution). This group builds one unified catalog of both, and can
  // generate a SKILL.md per server for Claude Code / Cursor / Goose
  // auto-discovery.

  async function runSkillsList(options: { json?: boolean; skillsDir?: string }): Promise<void> {
    const {
      discoverSkills,
      buildSkillCatalog,
      renderSkillCatalog,
      defaultSkillsDirs,
    } = await import("./skills.js");
    const dirs = options.skillsDir ? [options.skillsDir] : defaultSkillsDirs();
    const { skills, warnings } = await discoverSkills(dirs);
    const catalog = buildSkillCatalog(skills, SERVER_REGISTRY);
    if (options.json) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }
    console.log(renderSkillCatalog(catalog));
    for (const warning of warnings) {
      console.log(chalk.yellow(`Skipped ${warning.source}: ${warning.reason}`));
    }
  }

  const skillsCmd = program
    .command("skills")
    .alias("skill")
    .description("Unified catalog of local Agent Skills (workflow knowledge) and MCP servers (execution).")
    .option("--json", "Print the catalog as JSON.")
    .option("--skills-dir <dir>", "Scan a single skills directory instead of the defaults.")
    .action(async (options: { json?: boolean; skillsDir?: string }) => {
      await runSkillsList(options);
    });

  skillsCmd
    .command("list")
    .description("List the unified skill + MCP server catalog.")
    .option("--json", "Print the catalog as JSON.")
    .option("--skills-dir <dir>", "Scan a single skills directory instead of the defaults.")
    .action(async (options: { json?: boolean; skillsDir?: string }) => {
      await runSkillsList(options);
    });

  skillsCmd
    .command("generate")
    .description("Generate a SKILL.md per UMT server for Claude Code / Cursor / Goose auto-discovery.")
    .option("-s, --server <serverIds...>", "Only generate for these server IDs (default: all).")
    .option("--out <dir>", "Output directory (default: ./.agents/skills).")
    .action(async (options: { server?: string[]; out?: string }) => {
      const { writeServerSkills, defaultSkillsOutDir } = await import("./skills.js");
      let entries = SERVER_REGISTRY;
      if (options.server?.length) {
        const wanted = new Set(options.server);
        entries = SERVER_REGISTRY.filter((e) => wanted.has(e.id));
        const missing = options.server.filter((id) => !entries.some((e) => e.id === id));
        for (const id of missing) {
          console.log(chalk.yellow(`Unknown server '${id}' — skipped.`));
        }
      }
      const outDir = options.out ?? defaultSkillsOutDir();
      const written = await writeServerSkills(entries, outDir);
      console.log(chalk.green(`Wrote ${written.length} SKILL.md file(s) to ${outDir}:`));
      for (const filePath of written) {
        console.log(`  ${filePath}`);
      }
      console.log(chalk.gray("Claude Code auto-discovers ./.agents/skills/*/SKILL.md — no restart needed."));
    });

  // --- `umt plugin` — Agent Plugins 1.0 distribution engine -------------------
  // The Agent Plugins 1.0 spec (agent-plugins.org) makes Agent Skills +
  // mcp.json a portable cross-client package but defines no CLI and no trust
  // model. `umt plugin pack` generates a complete installable package from
  // any UMT server selection; `umt plugin audit` deterministically
  // security-scans a package directory before it is distributed.

  const pluginCmd = program
    .command("plugin")
    .description("Build and audit portable Agent Plugins 1.0 packages (plugin.json + mcp.json + skills/ + SEP-2640 skills.json).");

  pluginCmd
    .command("pack")
    .description("Generate an installable Agent Plugins 1.0 package from UMT servers.")
    .requiredOption("--servers <serverIds...>", "UMT server IDs to include in the package.")
    .requiredOption("--name <name>", "Plugin name (spec: 1-64 lowercase chars, a-z 0-9 . -).")
    .option("--description <text>", "Plugin description (default: generated from the server list).")
    .option("--version <version>", "Plugin version (default: CLI version).")
    .option("--out <dir>", "Output directory (default: ./<name>).")
    .option("--dry-run", "List what would be emitted without writing any files.")
    .action(
      async (options: {
        servers: string[];
        name: string;
        description?: string;
        version?: string;
        out?: string;
        dryRun?: boolean;
      }) => {
        const { planPluginPack, writePluginPack } = await import("./plugin-pack.js");
        let plan;
        try {
          plan = planPluginPack(
            {
              name: options.name,
              serverIds: options.servers,
              description: options.description,
              version: options.version,
              outDir: options.out,
            },
            CLI_VERSION,
          );
        } catch (error) {
          console.error(chalk.red(`pack failed: ${error instanceof Error ? error.message : String(error)}`));
          process.exit(1);
        }
        if (options.dryRun) {
          console.log(chalk.cyan(`Would emit ${plan.files.length} file(s) to ${plan.outDir}:`));
          for (const file of plan.files) {
            console.log(`  ${file.relativePath} ${chalk.gray(`(${file.kind})`)}`);
          }
          return;
        }
        const written = await writePluginPack(plan);
        console.log(chalk.green(`Wrote ${written.length} file(s) to ${plan.outDir}:`));
        for (const filePath of written) {
          console.log(`  ${filePath}`);
        }
        // Persist the SEP-2640 skill digests alongside `umt vet`'s drift pins
        // so later audits can detect drifted skill content. Non-fatal: a
        // read-only state dir must not fail the pack itself.
        const { manifestForPlan, recordSkillPins } = await import("./plugin-pack.js");
        const pinsPersisted = await recordSkillPins(plan, manifestForPlan(plan));
        if (pinsPersisted) {
          console.log(chalk.gray(`Recorded skill digest pins for drift checks.`));
        } else {
          console.log(chalk.yellow(`Warning: could not persist skill digest pins (state directory unwritable).`));
        }
        console.log(chalk.gray(`Audit before distributing: umt plugin audit ${plan.outDir}`));
      },
    );

  pluginCmd
    .command("audit")
    .description("Deterministically security-scan an Agent Plugins 1.0 package directory.")
    .argument("<dir>", "Plugin package directory to audit.")
    .option("--json", "Print the findings as JSON instead of human-readable text.")
    .action(async (dir: string, options: { json?: boolean }) => {
      const { auditPluginPackage, formatAuditResult } = await import("./plugin-audit.js");
      const result = await auditPluginPackage(dir);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatAuditResult(result));
      if (!result.ok) {
        process.exit(1);
      }
    });

  await program.parseAsync(argv);

  const updateNotification = await updateNotificationPromise;
  if (updateNotification) {
    console.log(
      chalk.cyan(
        `📦 New version available: v${updateNotification.currentVersion} → v${updateNotification.latestVersion}\n` +
          `   Run \`${chalk.bold(updateNotification.updateCommand)}\` to update.\n`,
      ),
    );
  }
}

/**
 * Format a duration in milliseconds as a human-readable uptime string.
 * Examples: "5s", "2m 30s", "1h 15m", "3d 4h"
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
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
    console.log(
      chalk.cyan("Server".padEnd(18)) +
      chalk.cyan("PID".padEnd(10)) +
      chalk.cyan("Port".padEnd(10)) +
      chalk.cyan("Transport".padEnd(12)) +
      chalk.cyan("Uptime".padEnd(15)) +
      chalk.cyan("Restarts"),
    );
    
    for (const proc of state.processes) {
      const startTime = new Date(proc.startTime);
      const uptime = Date.now() - startTime.getTime();
      const uptimeStr = formatUptime(uptime);
      const transport = proc.port ? "sse" : "stdio";
      console.log(
        proc.serverId.padEnd(18) +
        String(proc.pid).padEnd(10) +
        String(proc.port || "-").padEnd(10) +
        transport.padEnd(12) +
        uptimeStr.padEnd(15) +
        String(proc.restartCount || 0),
      );
    }
  } catch (error) {
    console.log(chalk.yellow("No servers currently running."));
    console.log(chalk.gray("Use 'umt run <server>' to start a server."));
  }
}

/** Maximum log file size before rotation kicks in (10 MB). */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
/** Number of rotated log files to keep. */
const MAX_LOG_BACKUPS = 5;

/**
 * Rotate the log file for a server if it exceeds MAX_LOG_SIZE_BYTES.
 * Keeps up to MAX_LOG_BACKUPS rotated copies (server.log.1, server.log.2, etc.).
 */
async function rotateLogFile(logFile: string): Promise<void> {
  try {
    const fileStat = await stat(logFile).catch(() => undefined);
    if (!fileStat || fileStat.size <= MAX_LOG_SIZE_BYTES) {
      return;
    }
    // Shift existing rotated files: .4 -> .5 (deleted), .3 -> .4, etc.
    for (let i = MAX_LOG_BACKUPS; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const to = `${logFile}.${i}`;
      try {
        await rm(to, { force: true });
        await rename(from, to);
      } catch {
        // File may not exist; that's fine
      }
    }
  } catch {
    // Rotation is best-effort; never fail the logs command because of it
  }
}

/**
 * Tail or display log lines for a specific server.
 * Supports `--follow` for live tailing, `--grep` for filtering, and
 * automatic log rotation when files exceed the size limit.
 *
 * @param serverName - The server ID to read logs for
 * @param lines - Number of lines to display (when not following)
 * @param follow - When true, stream new lines as they are written
 * @param grep - Optional regex pattern to filter log lines
 */
async function runLogs(serverName: string, lines: number, follow: boolean, grep?: string): Promise<void> {
  try {
    const { getStateDirectory } = await import("./config-store.js");
    const logDir = path.join(getStateDirectory(), "logs");
    const logFile = path.join(logDir, `${serverName}.log`);
    
    if (!(await pathExists(logFile))) {
      console.log(chalk.red(`No logs found for '${serverName}'.`));
      return;
    }
    
    // Rotate if the log file is too large
    await rotateLogFile(logFile);
    
    // Escape user input before constructing a regex to prevent ReDoS attacks
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const grepRegex = grep ? new RegExp(escapeRegExp(grep), "i") : null;
    
    if (follow) {
      console.log(chalk.gray(`Following logs for ${serverName}... (Ctrl+C to stop)`));
      const stream = createReadStream(logFile);
      const rl = createInterface({ input: stream });
      
      stream.on('error', (err) => {
        console.log(chalk.red(`Error reading log: ${err.message}`));
      });
      
      rl.on('line', (line) => {
        if (!grepRegex || grepRegex.test(line)) {
          console.log(line);
        }
      });
    } else {
      const contents = await readFile(logFile, "utf8");
      const allLines = contents.split("\n");
      const filteredLines = grepRegex
        ? allLines.filter((line) => grepRegex.test(line))
        : allLines;
      const lastLines = filteredLines.slice(-lines);
      console.log(lastLines.join("\n"));
    }
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

/**
 * Check npm registry for newer versions and optionally upgrade.
 *
 * @param allPackages - When true, check all server packages
 * @param serverName - Optional specific server to check
 * @param dryRun - When true, show what would change without making modifications
 */
async function runUpgrade(allPackages: boolean, serverName?: string, dryRun?: boolean): Promise<void> {
  const spinner = (await oraLazy(dryRun ? "Checking for updates (dry run)..." : "Checking for updates...")).start();
  
  try {
    if (serverName) {
      const entry = getRegistryEntry(serverName);
      const { stdout } = await execNpm(["view", entry.packageName, "version"]);
      const result = stdout.trim();
      spinner.succeed(`Current version: ${entry.packageName}`);
      console.log(`Latest version in npm: ${chalk.green(result)}`);
      if (dryRun) {
        console.log(chalk.gray(`(dry run: no changes made)`));
      }
    } else if (allPackages) {
      const packages = SERVER_REGISTRY.map(e => e.packageName);
      for (const pkg of packages) {
        const { stdout } = await execNpm(["view", pkg, "version"]);
        const result = stdout.trim();
        console.log(`${pkg}: ${chalk.green(result)}`);
      }
      spinner.succeed("All packages checked.");
      if (dryRun) {
        console.log(chalk.gray(`(dry run: no changes made)`));
      }
    } else {
      const pkg = "universal-mcp-toolkit";
      const { stdout } = await execNpm(["view", pkg, "version"]);
      const result = stdout.trim();
      spinner.succeed(`CLI version: ${chalk.green(result)}`);
      if (dryRun) {
        console.log(chalk.gray(`(dry run: no changes made)`));
      }
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

  const spinner = (await oraLazy("Writing config...")).start();
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
    entry.description.toLowerCase().includes(lowerQuery) ||
    entry.toolNames.some(tool => tool.toLowerCase().includes(lowerQuery))
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
  const mcpConfigPath = path.join(configDir, "memos-mcp.json");
  await mkdir(configDir, { recursive: true });
  
  const config = { memosPath: pathToUse };
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const mcpConfig = {
    mcpServers: {
      memos: {
        command: "npx",
        args: ["-y", "@mem-os/sdk", "mcp", "--db", pathToUse],
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  
  console.log(chalk.green(`MemOS linked at ${pathToUse}.`));
  console.log(chalk.gray(`Wrote MemOS MCP config: ${mcpConfigPath}`));
}

async function runProfileCreate(name: string): Promise<void> {
  const target = await promptForTarget();
  const serverIds = await promptForServers();
  const mode = await promptForMode();
  const outputPath = await promptForOutputPath(target);
  
  const spinner = (await oraLazy(`Creating profile '${name}'...`)).start();
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
    
    const spinner = (await oraLazy(`Importing profile '${profile.name}'...`)).start();
    await saveNamedProfile(profile);
    spinner.succeed(`Profile '${profile.name}' imported`);
  } catch (error) {
    console.log(chalk.red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown CLI failure";
    console.error(chalk.red(message));
    process.exit(1);
  });
}
