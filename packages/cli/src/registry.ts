import os from "node:os";
import path from "node:path";

export type ConfigTarget =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "kilo"
  | "cline"
  | "omp"
  | "pi"
  | "codex"
  | "openclaw"
  | "zcode"
  | "windsurf"
  | "zed"
  | "vscode"
  | "opencode"
  | "gemini-cli"
  | "json";

/**
 * How a target's config file stores MCP servers.
 *
 * - `mcpServers-json` — `{ "mcpServers": { … } }` (Claude Code/Desktop, Cursor, …)
 * - `vscode-json`     — `{ "servers": { … } }` with `type: "stdio"` (VS Code)
 * - `zed-json`        — `{ "context_servers": { … } }` with `command: { path, args }`
 * - `opencode-json`   — `{ "mcp": { … } }` with `type: "local"` and a command array
 * - `openclaw-json`   — `{ "mcp": { "servers": { … } } }` (nested)
 * - `codex-toml`      — `[mcp_servers.<name>]` TOML tables
 * - `json`            — stdout dump in the plain `mcpServers` shape
 */
export type TargetShape =
  | "mcpServers-json"
  | "vscode-json"
  | "zed-json"
  | "opencode-json"
  | "openclaw-json"
  | "codex-toml"
  | "json";

/** Per-server entry shape used when serializing a JSON target. */
export type EntryStyle = "plain" | "vscode" | "opencode";

/** Where a shape keeps its server map, and how a write merges into an existing file. */
export interface ShapeSpec {
  /** Key path to the server map inside the config document (`[]` for TOML). */
  serverKey: readonly string[];
  /** Per-server entry shape. */
  entryStyle: EntryStyle;
  /** `json-merge` merges the server map; `toml-block` rewrites managed tables. */
  merge: "json-merge" | "toml-block";
}

export const SHAPE_SPECS: Readonly<Record<TargetShape, ShapeSpec>> = {
  "mcpServers-json": { serverKey: ["mcpServers"], entryStyle: "plain", merge: "json-merge" },
  "vscode-json": { serverKey: ["servers"], entryStyle: "vscode", merge: "json-merge" },
  "zed-json": { serverKey: ["context_servers"], entryStyle: "plain", merge: "json-merge" },
  "opencode-json": { serverKey: ["mcp"], entryStyle: "opencode", merge: "json-merge" },
  "openclaw-json": { serverKey: ["mcp", "servers"], entryStyle: "plain", merge: "json-merge" },
  "codex-toml": { serverKey: [], entryStyle: "plain", merge: "toml-block" },
  json: { serverKey: ["mcpServers"], entryStyle: "plain", merge: "json-merge" },
};

export interface TargetSpec {
  /** The id accepted by `umt config -t <id>`. */
  id: ConfigTarget;
  /** Human-readable harness name for prompts and logs. */
  label: string;
  /** Output shape of the emitted config. */
  shape: TargetShape;
  /**
   * Resolve the harness's user-scope config path for the current OS, or
   * `undefined` when the config is workspace-scoped (`workspacePath`) or the
   * target only dumps a snippet to stdout (`json`).
   * `home` is the user's home directory; `env` is `process.env`.
   */
  defaultPath?: (home: string, env: NodeJS.ProcessEnv) => string;
  /**
   * Path relative to the current working directory for workspace-scoped
   * harnesses (VS Code, project-scope Claude Code). Takes precedence over
   * `defaultPath` when both are set.
   */
  workspacePath?: string;
  /**
   * True when the default path and schema were confirmed against the
   * harness's official docs; false when the best-documented path was used
   * but could not be confirmed. Surfaced as a note in the CLI and in docs.
   */
  verified: boolean;
  /** Official documentation for this harness's MCP configuration. */
  docsUrl: string;
}

export type InvocationMode = "npx" | "workspace";

export interface ServerRegistryEntry {
  id: string;
  title: string;
  category: string;
  description: string;
  packageName: string;
  npxArgs?: readonly string[];
  envVarNames: readonly string[];
  transports: readonly ("stdio" | "sse" | "streamable-http")[];
  /**
   * The list of tool names exposed by this server.
   * Populated from the server's well-known/mcp-server.json `tools` array.
   * Used by `umt list` to show tool counts and by `umt search` to match
   * tool names in addition to server names and descriptions.
   */
  toolNames: readonly string[];
  experimental?: boolean;
}

export const SERVER_REGISTRY: readonly ServerRegistryEntry[] = [
  {
    id: "github",
    title: "GitHub",
    category: "Collaboration",
    description: "Repository search, pull requests, workflows, and issue triage.",
    packageName: "@universal-mcp-toolkit/server-github",
    envVarNames: ["GITHUB_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["get_pull_request", "list_workflow_runs", "search_repositories"],
  },
  {
    id: "notion",
    title: "Notion",
    category: "Collaboration",
    description: "Search pages and databases, read docs, and publish structured notes.",
    packageName: "@universal-mcp-toolkit/server-notion",
    envVarNames: ["NOTION_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["search-pages", "get-page", "create-page"],
  },
  {
    id: "slack",
    title: "Slack",
    category: "Collaboration",
    description: "Look up channels, fetch threads, and post workspace updates.",
    packageName: "@universal-mcp-toolkit/server-slack",
    envVarNames: ["SLACK_BOT_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["list_channels", "fetch_channel_history", "post_message"],
  },
  {
    id: "linear",
    title: "Linear",
    category: "Collaboration",
    description: "Search issues, inspect workflow state, and create new work items.",
    packageName: "@universal-mcp-toolkit/server-linear",
    envVarNames: ["LINEAR_API_KEY"],
    transports: ["stdio", "sse"],
    toolNames: ["search_issues", "get_issue", "create_issue"],
  },
  {
    id: "jira",
    title: "Jira",
    category: "Collaboration",
    description: "Search issues, inspect tickets, and drive incident triage.",
    packageName: "@universal-mcp-toolkit/server-jira",
    envVarNames: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["get_issue", "search_issues", "transition_issue"],
  },
  {
    id: "google-calendar",
    title: "Google Calendar",
    category: "Productivity",
    description: "List calendars, inspect events, and schedule meetings.",
    packageName: "@universal-mcp-toolkit/server-google-calendar",
    envVarNames: ["GOOGLE_CALENDAR_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["list-calendars", "list-events", "create-event"],
  },
  {
    id: "google-drive",
    title: "Google Drive",
    category: "Productivity",
    description: "Search Drive, inspect document metadata, and export files.",
    packageName: "@universal-mcp-toolkit/server-google-drive",
    envVarNames: ["GOOGLE_DRIVE_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["search-files", "get-file-metadata", "export-file"],
  },
  {
    id: "spotify",
    title: "Spotify",
    category: "Media & Commerce",
    description: "Search tracks, inspect playback, and curate playlists.",
    packageName: "@universal-mcp-toolkit/server-spotify",
    envVarNames: ["SPOTIFY_ACCESS_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["currently-playing", "search-tracks", "list-playlists"],
  },
  {
    id: "stripe",
    title: "Stripe",
    category: "Media & Commerce",
    description: "Inspect billing state, customers, invoices, and subscriptions.",
    packageName: "@universal-mcp-toolkit/server-stripe",
    envVarNames: ["STRIPE_SECRET_KEY"],
    transports: ["stdio", "sse"],
    toolNames: ["list-customers", "get-invoice", "list-subscriptions"],
  },
  {
    id: "postgresql",
    title: "PostgreSQL",
    category: "Data",
    description: "Inspect schemas and run guarded SQL queries.",
    packageName: "@universal-mcp-toolkit/server-postgresql",
    envVarNames: ["POSTGRESQL_URL"],
    transports: ["stdio", "sse"],
    toolNames: ["list-tables", "describe-table", "run-query"],
  },
  {
    id: "mongodb",
    title: "MongoDB",
    category: "Data",
    description: "Explore collections and run filtered document queries.",
    packageName: "@universal-mcp-toolkit/server-mongodb",
    envVarNames: ["MONGODB_URI"],
    transports: ["stdio", "sse"],
    toolNames: ["list-collections", "find-documents", "aggregate-documents"],
  },
  {
    id: "redis",
    title: "Redis",
    category: "Data",
    description: "Inspect keys, TTLs, and runtime cache diagnostics.",
    packageName: "@universal-mcp-toolkit/server-redis",
    envVarNames: ["REDIS_URL"],
    transports: ["stdio", "sse"],
    toolNames: ["get-key", "set-key", "inspect-server-info"],
  },
  {
    id: "supabase",
    title: "Supabase",
    category: "Data",
    description: "Query tables, storage, and operational project metadata.",
    packageName: "@universal-mcp-toolkit/server-supabase",
    envVarNames: ["SUPABASE_URL", "SUPABASE_KEY"],
    transports: ["stdio", "sse"],
    toolNames: ["list-tables", "query-table", "list-storage-buckets"],
  },
  {
    id: "vercel",
    title: "Vercel",
    category: "Platform",
    description: "Track projects, deployments, and environment settings.",
    packageName: "@universal-mcp-toolkit/server-vercel",
    envVarNames: ["VERCEL_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["list_projects", "list_deployments", "get_deployment"],
  },
  {
    id: "cloudflare-workers",
    title: "Cloudflare Workers",
    category: "Platform",
    description: "Inspect workers, routes, and edge rollout state.",
    packageName: "@universal-mcp-toolkit/server-cloudflare-workers",
    envVarNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    transports: ["stdio", "sse"],
    toolNames: ["list_workers", "get_worker", "list_routes"],
  },
  {
    id: "docker",
    title: "Docker",
    category: "Platform",
    description: "Inspect containers, images, and daemon state.",
    packageName: "@universal-mcp-toolkit/server-docker",
    envVarNames: [],
    transports: ["stdio", "sse"],
    toolNames: ["list_containers", "inspect_container", "list_images"],
  },
  {
    id: "npm-registry",
    title: "NPM Registry",
    category: "Platform",
    description: "Search packages, inspect versions, and review release metadata.",
    packageName: "@universal-mcp-toolkit/server-npm-registry",
    envVarNames: [],
    transports: ["stdio", "sse"],
    toolNames: ["search_packages", "get_package_metadata", "list_package_versions"],
  },
  {
    id: "hackernews",
    title: "Hacker News",
    category: "Research",
    description: "Search trends, fetch top stories, and inspect discussion threads.",
    packageName: "@universal-mcp-toolkit/server-hackernews",
    envVarNames: [],
    transports: ["stdio", "sse"],
    toolNames: ["get_top_stories", "search_stories", "get_item_thread"],
  },
  {
    id: "arxiv",
    title: "arXiv",
    category: "Research",
    description: "Search papers and build compact literature digests.",
    packageName: "@universal-mcp-toolkit/server-arxiv",
    envVarNames: [],
    transports: ["stdio", "sse"],
    toolNames: ["search_papers", "get_paper", "list_recent_papers"],
    experimental: true,
  },
  {
    id: "filesystem",
    title: "FileSystem",
    category: "Local",
    description: "Read and write files safely inside explicitly allowed roots.",
    packageName: "@universal-mcp-toolkit/server-filesystem",
    envVarNames: ["FILESYSTEM_ROOTS"],
    transports: ["stdio", "sse"],
    toolNames: ["list_files", "read_file", "write_file"],
  },
  {
    id: "discord",
    title: "Discord",
    category: "Collaboration",
    description: "Guild discovery, channel lookup, message history, and messaging.",
    packageName: "@universal-mcp-toolkit/server-discord",
    envVarNames: ["DISCORD_BOT_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["discord_list_guilds", "discord_list_channels", "discord_get_messages", "discord_send_message", "discord_get_guild_members"],
  },
  {
    id: "airtable",
    title: "Airtable",
    category: "Data",
    description: "Table listing, record CRUD, and filtering for Airtable bases.",
    packageName: "@universal-mcp-toolkit/server-airtable",
    envVarNames: ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID"],
    transports: ["stdio", "sse"],
    toolNames: ["airtable_list_tables", "airtable_get_records", "airtable_create_record", "airtable_update_record", "airtable_delete_record"],
  },
  {
    id: "trello",
    title: "Trello",
    category: "Collaboration",
    description: "Board and list discovery, card CRUD, and archiving.",
    packageName: "@universal-mcp-toolkit/server-trello",
    envVarNames: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: ["trello_list_boards", "trello_list_lists", "trello_list_cards", "trello_create_card", "trello_update_card", "trello_archive_card"],
  },
  {
    id: "memos",
    title: "MemOS",
    category: "Memory",
    description: "Local-first persistent memory over MCP, backed by a MemOS SQLite database.",
    packageName: "@mem-os/sdk",
    npxArgs: ["-y", "@mem-os/sdk", "mcp"],
    envVarNames: [],
    transports: ["stdio"],
    toolNames: [],
  },
  {
    id: "notion-mcp",
    title: "Notion (MCP)",
    category: "Collaboration",
    description: "Full Notion workspace integration with search, CRUD on pages and databases.",
    packageName: "@contextcore/mcp-notion",
    envVarNames: ["NOTION_API_KEY"],
    transports: ["stdio", "sse"],
    toolNames: [],
  },
  {
    id: "playwright-mcp",
    title: "Playwright (MCP)",
    category: "Automation",
    description: "Browser automation and web scraping with Playwright.",
    packageName: "@contextcore/mcp-playwright",
    envVarNames: [],
    transports: ["stdio", "sse"],
    toolNames: [],
  },
  {
    id: "slack-mcp",
    title: "Slack (MCP)",
    category: "Collaboration",
    description: "Full Slack workspace integration with channels, messages, users, and files.",
    packageName: "@contextcore/mcp-slack",
    envVarNames: ["SLACK_BOT_TOKEN"],
    transports: ["stdio", "sse"],
    toolNames: [],
  },
  {
    id: "openai-mcp",
    title: "OpenAI (MCP)",
    category: "AI",
    description: "OpenAI/Codex API integration with chat, completion, embedding, and more.",
    packageName: "@contextcore/mcp-openai",
    envVarNames: ["OPENAI_API_KEY"],
    transports: ["stdio", "sse"],
    toolNames: [],
  }
];
export function getRegistryEntry(id: string): ServerRegistryEntry {
  const entry = SERVER_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown server '${id}'.`);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Harness config-target registry (data-driven)
// ---------------------------------------------------------------------------

function joinPath(...segments: string[]): string {
  return path.join(...segments);
}

function claudeDesktopPath(home: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return joinPath(env.APPDATA ?? joinPath(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return joinPath(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "Claude", "claude_desktop_config.json");
}

function zedPath(home: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return joinPath(env.APPDATA ?? joinPath(home, "AppData", "Roaming"), "Zed", "settings.json");
  }
  if (process.platform === "darwin") {
    return joinPath(home, "Library", "Application Support", "Zed", "settings.json");
  }
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "zed", "settings.json");
}

function vscodeGlobalStorageMcp(home: string, env: NodeJS.ProcessEnv, relative: string): string {
  if (process.platform === "win32") {
    return joinPath(env.APPDATA ?? joinPath(home, "AppData", "Roaming"), "Code", "User", "globalStorage", relative);
  }
  if (process.platform === "darwin") {
    return joinPath(home, "Library", "Application Support", "Code", "User", "globalStorage", relative);
  }
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "Code", "User", "globalStorage", relative);
}

function xdgConfig(home: string, env: NodeJS.ProcessEnv, ...rest: string[]): string {
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), ...rest);
}

/**
 * Every harness `umt config -t` can target, with the path and document shape
 * UMT uses to write its MCP configuration.
 *
 * `verified: true` means the path and schema were confirmed against the
 * harness's official docs (`docsUrl`). `verified: false` marks a target where
 * the best-documented path was used but could not be confirmed from official
 * docs — `umt config` prints a warning for those.
 */
export const TARGET_REGISTRY: readonly TargetSpec[] = [
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    shape: "mcpServers-json",
    defaultPath: claudeDesktopPath,
    verified: true,
    docsUrl: "https://modelcontextprotocol.io/quickstart/user",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    shape: "mcpServers-json",
    // Project scope (./.mcp.json) wins for a repo; the user-scope file is
    // ~/.claude.json and is used when --write points at it.
    defaultPath: (home) => joinPath(home, ".claude.json"),
    workspacePath: ".mcp.json",
    verified: true,
    docsUrl: "https://docs.claude.com/en/docs/claude-code/mcp",
  },
  {
    id: "cursor",
    label: "Cursor",
    shape: "mcpServers-json",
    defaultPath: (home) => joinPath(home, ".cursor", "mcp.json"),
    verified: true,
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
  },
  {
    id: "kilo",
    label: "Kilo Code",
    // Kilo's current config file is kilo.jsonc and servers live under the
    // top-level `mcp` key in the same local/command-array shape as OpenCode —
    // not under `mcpServers` in .kilocode/mcp.json (the older format).
    shape: "opencode-json",
    defaultPath: (home, env) => xdgConfig(home, env, "kilo", "kilo.jsonc"),
    verified: true,
    docsUrl: "https://kilo.ai/docs/automate/mcp/using-in-kilo-code",
  },
  {
    id: "cline",
    label: "Cline (VS Code)",
    shape: "mcpServers-json",
    defaultPath: (home, env) =>
      vscodeGlobalStorageMcp(home, env, joinPath("saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")),
    verified: true,
    docsUrl: "https://docs.cline.bot/mcp/configuring-mcp-servers",
  },
  {
    id: "omp",
    label: "omp (Oh My Pi)",
    shape: "mcpServers-json",
    // OMP's native user config; the project equivalent is .omp/mcp.json.
    defaultPath: (home) => joinPath(home, ".omp", "agent", "mcp.json"),
    verified: true,
    docsUrl: "https://github.com/can1357/oh-my-pi/blob/HEAD/docs/mcp-config.md",
  },
  {
    id: "pi",
    label: "pi",
    shape: "mcpServers-json",
    // MCP support ships as the pi-mcp-adapter extension. Its documented
    // shared user-global config is ~/.config/mcp/mcp.json; project ./.mcp.json.
    defaultPath: (home, env) => xdgConfig(home, env, "mcp", "mcp.json"),
    workspacePath: ".mcp.json",
    verified: true,
    docsUrl: "https://pi.dev/packages/pi-mcp-adapter",
  },
  {
    id: "codex",
    label: "Codex",
    shape: "codex-toml",
    defaultPath: (home) => joinPath(home, ".codex", "config.toml"),
    verified: true,
    docsUrl: "https://developers.openai.com/codex/mcp",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    shape: "openclaw-json",
    defaultPath: (home) => joinPath(home, ".openclaw", "openclaw.json"),
    verified: true,
    docsUrl: "https://docs.openclaw.ai/gateway/config-extensions",
  },
  {
    id: "zcode",
    label: "ZCode",
    // ZCode's native config nests servers under mcp.servers; the workspace
    // equivalent is <project root>/.zcode/config.json.
    shape: "openclaw-json",
    defaultPath: (home) => joinPath(home, ".zcode", "cli", "config.json"),
    verified: true,
    docsUrl: "https://zcode.z.ai/en/docs/mcp-services",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    shape: "mcpServers-json",
    defaultPath: (home) => joinPath(home, ".codeium", "windsurf", "mcp_config.json"),
    verified: true,
    docsUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
  },
  {
    id: "zed",
    label: "Zed",
    // Zed's local servers use a flat command/args/env entry under
    // context_servers (see docs), not the nested command:{path,args} form.
    shape: "zed-json",
    defaultPath: zedPath,
    verified: true,
    docsUrl: "https://zed.dev/docs/ai/mcp",
  },
  {
    id: "vscode",
    label: "VS Code",
    shape: "vscode-json",
    workspacePath: ".vscode/mcp.json",
    verified: true,
    docsUrl: "https://code.visualstudio.com/docs/copilot/chat/mcp-servers",
  },
  {
    id: "opencode",
    label: "OpenCode",
    shape: "opencode-json",
    defaultPath: (home, env) => xdgConfig(home, env, "opencode", "opencode.json"),
    verified: true,
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    shape: "mcpServers-json",
    defaultPath: (home) => joinPath(home, ".gemini", "settings.json"),
    verified: true,
    docsUrl: "https://developers.google.com/gemini-code-assist/docs/gemini-cli",
  },
  {
    id: "json",
    label: "Raw JSON (stdout)",
    shape: "json",
    verified: true,
    docsUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  },
];

export function getTargetSpec(id: string): TargetSpec {
  const spec = TARGET_REGISTRY.find((candidate) => candidate.id === id);
  if (!spec) {
    throw new Error(`Unknown target '${id}'. Supported targets: ${listConfigTargets().join(", ")}.`);
  }
  return spec;
}

/** Target ids in registry order, for CLI help and interactive prompts. */
export function listConfigTargets(): ConfigTarget[] {
  return TARGET_REGISTRY.map((target) => target.id);
}

/** Type guard for `-t` values coming from the command line. */
export function isConfigTarget(value: string): value is ConfigTarget {
  return TARGET_REGISTRY.some((target) => target.id === value);
}

/** Registry entries whose path/schema could not be confirmed from official docs. */
export function getUnverifiedTargets(): TargetSpec[] {
  return TARGET_REGISTRY.filter((target) => !target.verified);
}

/**
 * The file `umt config -t <target>` writes to when no explicit path is given:
 * the workspace-relative path for workspace-scoped harnesses, otherwise the
 * harness's user-scope path. `undefined` for targets that only dump a snippet
 * to stdout (`json`).
 */
export function getTargetDefaultPath(id: ConfigTarget, cwd: string = process.cwd()): string | undefined {
  const spec = getTargetSpec(id);
  if (spec.workspacePath) {
    return path.resolve(cwd, spec.workspacePath);
  }
  return spec.defaultPath?.(os.homedir(), process.env);
}
