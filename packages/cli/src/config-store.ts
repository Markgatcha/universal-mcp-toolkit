import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { ConfigTarget, InvocationMode, ServerRegistryEntry } from "./registry.js";

const require = createRequire(import.meta.url);

export interface InstallProfile {
  target: ConfigTarget;
  mode: InvocationMode;
  outputPath: string;
  serverIds: string[];
  createdAt: string;
}

export interface CliState {
  installs: InstallProfile[];
}

export interface GeneratedConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  >;
}

export function getStateDirectory(): string {
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, "universal-mcp-toolkit")
    : path.join(os.homedir(), ".universal-mcp-toolkit");
}

export function getStateFilePath(): string {
  return path.join(getStateDirectory(), "state.json");
}

export function getGeneratedConfigPath(target: ConfigTarget): string {
  return path.join(getStateDirectory(), `${target}.json`);
}

export async function readState(): Promise<CliState> {
  try {
    const contents = await readFile(getStateFilePath(), "utf8");
    return JSON.parse(contents) as CliState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { installs: [] };
    }

    throw error;
  }
}

export async function writeState(state: CliState): Promise<void> {
  await mkdir(getStateDirectory(), { recursive: true });
  await writeFile(getStateFilePath(), JSON.stringify(state, null, 2), "utf8");
}

export async function saveInstallProfile(profile: InstallProfile): Promise<void> {
  const state = await readState();
  state.installs.unshift(profile);
  await writeState({
    installs: state.installs.slice(0, 10),
  });
}

function resolvePackageRoot(packageName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  return path.dirname(packageJsonPath);
}

export function resolveWorkspaceEntryFile(entry: ServerRegistryEntry): string {
  return path.join(resolvePackageRoot(entry.packageName), "dist", "index.js");
}

export function createPlaceholderEnv(entry: ServerRegistryEntry): Record<string, string> | undefined {
  if (entry.envVarNames.length === 0) {
    return undefined;
  }

  const env = Object.fromEntries(entry.envVarNames.map((name) => [name, `\${${name}}`]));
  return env;
}

export function createGeneratedConfig(
  entries: readonly ServerRegistryEntry[],
  mode: InvocationMode,
): GeneratedConfig {
  const mcpServers = Object.fromEntries(
    entries.map((entry) => {
      const invocation =
        mode === "npx"
          ? {
              command: "npx",
              args: ["-y", entry.packageName, "--transport", "stdio"],
            }
          : {
              command: process.execPath,
              args: [resolveWorkspaceEntryFile(entry), "--transport", "stdio"],
            };

      const configEntry: {
        command: string;
        args: string[];
        env?: Record<string, string>;
      } = {
        ...invocation,
      };

      const placeholderEnv = createPlaceholderEnv(entry);
      if (placeholderEnv) {
        configEntry.env = placeholderEnv;
      }

      return [entry.id, configEntry];
    }),
  );

  return { mcpServers };
}

export async function writeGeneratedConfig(targetPath: string, generatedConfig: GeneratedConfig): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(generatedConfig, null, 2), "utf8");
}
