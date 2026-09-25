#!/usr/bin/env node
/**
 * Token-budget lint for UMT's MCP tool catalog.
 *
 * Measures every server's real on-the-wire `tools/list` payload — the same
 * bytes an MCP client pays for on every agent turn — by spawning each built
 * server over stdio and capturing the actual JSON-RPC response. This keeps
 * the measurement honest: it reflects SDK schema conversion, the core
 * `$schema`-stripping diet in `ToolkitServer`, and the real descriptions.
 *
 * Budgets were set from the measured 2026-09-25 post-diet baseline
 * (142 tools, ~43.3k tokens at ~4 chars/token) plus headroom:
 *   TOTAL_BUDGET_TOKENS  48_000  (~+11% over baseline)
 *   PER_TOOL_BUDGET_TOKENS    950  (max measured tool: ~814)
 *   PER_SERVER_BUDGET_TOKENS 6_500  (max measured server: ~5,706)
 *
 * Structural guards (these catch the diet rotting even when budgets pass):
 * - no `$schema` keyword anywhere in served schemas (the diet strips it)
 * - every tool description <= MAX_TOOL_DESCRIPTION_CHARS
 * - the README's "N production-focused MCP servers" claim matches the servers/ directory
 *
 * Token math is a heuristic (~4 chars/token, ±30%): budgets are set with
 * enough headroom that only real regressions trip them.
 *
 * Usage: node scripts/check-token-budget.mjs  (run after `pnpm build`)
 * Exit code 0 when all budgets pass, 1 with a report otherwise.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = join(REPO_ROOT, "servers");
const CHARS_PER_TOKEN = 4;

const TOTAL_BUDGET_TOKENS = 48_000;
const PER_TOOL_BUDGET_TOKENS = 950;
const PER_SERVER_BUDGET_TOKENS = 6_500;
const MAX_TOOL_DESCRIPTION_CHARS = 200;

/**
 * Placeholder credentials so servers boot far enough to answer `tools/list`.
 * Values are never used for real network calls — every probe is killed after
 * the list response (or a timeout) without invoking any tool.
 */
const PROBE_ENV = {
  FILESYSTEM_ROOTS: "/tmp",
  GITHUB_TOKEN: "dummy",
  GITHUB_PERSONAL_ACCESS_TOKEN: "dummy",
  SLACK_BOT_TOKEN: "xoxb-dummy",
  SLACK_TEAM_ID: "T000000",
  NOTION_API_KEY: "dummy",
  NOTION_TOKEN: "dummy",
  LINEAR_API_KEY: "dummy",
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_EMAIL: "a@example.com",
  JIRA_API_TOKEN: "dummy",
  TRELLO_API_KEY: "dummy",
  TRELLO_TOKEN: "dummy",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_KEY: "dummy",
  MONGODB_URI: "mongodb://localhost:27017",
  POSTGRESQL_URL: "postgres://localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SPOTIFY_ACCESS_TOKEN: "dummy",
  TWILIO_ACCOUNT_SID: "ACdummy",
  TWILIO_AUTH_TOKEN: "dummy",
  TWILIO_FROM_NUMBER: "+10000000000",
  VERCEL_TOKEN: "dummy",
  CLOUDFLARE_API_TOKEN: "dummy",
  CLOUDFLARE_ACCOUNT_ID: "dummy",
  AIRTABLE_API_KEY: "dummy",
  AIRTABLE_BASE_ID: "appDummy",
  OPENAI_API_KEY: "sk-dummy",
  DOCKER_HOST: "unix:///tmp/dummy.sock",
  YOUTUBE_API_KEY: "dummy",
  GMAIL_CLIENT_ID: "dummy",
  GMAIL_CLIENT_SECRET: "dummy",
  GMAIL_REFRESH_TOKEN: "dummy",
  GOOGLE_CALENDAR_ACCESS_TOKEN: "dummy",
  GOOGLE_DRIVE_ACCESS_TOKEN: "dummy",
  SHEETS_CLIENT_ID: "dummy",
  SHEETS_CLIENT_SECRET: "dummy",
  SHEETS_REFRESH_TOKEN: "dummy",
  DISCORD_BOT_TOKEN: "dummy",
  NPM_TOKEN: "dummy",
};

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n";
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            proc.stdout.off("data", onData);
            resolve(resp);
            return;
          }
        } catch {
          /* non-JSON stdout line (log preamble): ignore */
        }
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(msg);
    setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error(`timeout waiting for ${method}`));
    }, 15000);
  });
}

async function listServerTools(name) {
  const entry = join(SERVERS_DIR, name, "dist", "index.mjs");
  if (!existsSync(entry)) {
    throw new Error(`server '${name}' has no built entry at dist/index.mjs (run pnpm build first)`);
  }
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, ...PROBE_ENV },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const hardKill = setTimeout(() => proc.kill("SIGKILL"), 30000);
  try {
    await rpc(proc, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "token-budget-lint", version: "0.0.0" },
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc(proc, 2, "tools/list", {});
    if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error).slice(0, 200)}`);
    return list.result?.tools ?? [];
  } catch (error) {
    throw new Error(
      `could not list tools for server '${name}': ${error.message} | stderr: ${stderr.replace(/\n/g, " ").slice(0, 300)}`,
    );
  } finally {
    clearTimeout(hardKill);
    proc.kill("SIGKILL");
  }
}

function toolWireChars(tool) {
  return JSON.stringify({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }).length;
}

const failures = [];
const warnings = [];

const serverNames = readdirSync(SERVERS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let totalChars = 0;
let totalTools = 0;
const perServerTokens = [];
const perToolTokens = [];

for (const name of serverNames) {
  let tools;
  try {
    tools = await listServerTools(name);
  } catch (error) {
    failures.push(error.message);
    continue;
  }
  let serverChars = 0;
  for (const tool of tools) {
    const chars = toolWireChars(tool);
    serverChars += chars;
    totalTools++;
    const tokens = chars / CHARS_PER_TOKEN;
    perToolTokens.push({ server: name, tool: tool.name, tokens });
    if (tokens > PER_TOOL_BUDGET_TOKENS) {
      failures.push(
        `per-tool budget exceeded: ${name}/${tool.name} is ~${Math.round(tokens)} tokens (budget ${PER_TOOL_BUDGET_TOKENS})`,
      );
    }
    const desc = tool.description ?? "";
    if (desc.length > MAX_TOOL_DESCRIPTION_CHARS) {
      failures.push(
        `description too long: ${name}/${tool.name} description is ${desc.length} chars (max ${MAX_TOOL_DESCRIPTION_CHARS}) — keep tool descriptions short and keyword-rich`,
      );
    }
    if (JSON.stringify(tool).includes('"$schema"')) {
      failures.push(
        `redundant $schema keyword served by ${name}/${tool.name} — the core token diet should strip it (see ToolkitServer.installListToolsDiet)`,
      );
    }
  }
  totalChars += serverChars;
  const serverTokens = serverChars / CHARS_PER_TOKEN;
  perServerTokens.push({ server: name, tools: tools.length, tokens: serverTokens });
  if (serverTokens > PER_SERVER_BUDGET_TOKENS) {
    failures.push(
      `per-server budget exceeded: ${name} is ~${Math.round(serverTokens)} tokens across ${tools.length} tools (budget ${PER_SERVER_BUDGET_TOKENS})`,
    );
  }
}

const totalTokens = totalChars / CHARS_PER_TOKEN;
if (totalTokens > TOTAL_BUDGET_TOKENS) {
  failures.push(
    `total budget exceeded: catalog is ~${Math.round(totalTokens)} tokens across ${totalTools} tools (budget ${TOTAL_BUDGET_TOKENS})`,
  );
}

// Guard the documented server count against rot: READMEs must agree with the servers/ directory.
const readmes = ["README.md", "packages/cli/README.md", "packages/core/README.md"];
for (const rel of readmes) {
  const readme = readFileSync(join(REPO_ROOT, rel), "utf8");
  const claimed = [...readme.matchAll(/(\d+)\s+production-focused MCP servers/g)].map((m) => Number(m[1]));
  for (const n of claimed) {
    if (n !== serverNames.length) {
      failures.push(
        `${rel} claims ${n} production-focused MCP servers but the servers/ directory contains ${serverNames.length} — update the docs`,
      );
    }
  }
}

perServerTokens.sort((a, b) => b.tokens - a.tokens);
perToolTokens.sort((a, b) => b.tokens - a.tokens);

console.log(`token budget lint: ${totalTools} tools across ${serverNames.length} servers`);
console.log(`  total: ~${Math.round(totalTokens)} tokens (budget ${TOTAL_BUDGET_TOKENS})`);
console.log(
  `  biggest server: ${perServerTokens[0]?.server} ~${Math.round(perServerTokens[0]?.tokens ?? 0)} tokens (budget ${PER_SERVER_BUDGET_TOKENS})`,
);
console.log(
  `  biggest tool: ${perToolTokens[0]?.server}/${perToolTokens[0]?.tool} ~${Math.round(perToolTokens[0]?.tokens ?? 0)} tokens (budget ${PER_TOOL_BUDGET_TOKENS})`,
);
for (const w of warnings) console.log(`  warning: ${w}`);

if (failures.length > 0) {
  console.error("\nTOKEN BUDGET FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("token budget lint: PASS");
