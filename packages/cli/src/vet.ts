/**
 * `umt vet` / `umt add` / `umt doctor --vet` — CLI surface for live MCP
 * server vetting.
 *
 * The wire probes live in `@universal-mcp-toolkit/core` (`vetServer`); this
 * module owns the CLI concerns: resolving `<server-id-or-url>` to a vet
 * target, the `tools/list` digest-pin store (wired into the bridge's
 * drift-pin machinery via `digestToolsList`/`checkDefinitionDrift`), human
 * and `--json` reporting, and the exit-code contract:
 *
 * - `0` — clean: negotiated fine, no error-severity findings.
 * - `1` — security findings: at least one error-severity finding.
 * - `2` — protocol error: the server couldn't be vetted live at all.
 *
 * Drift pins: the bridge keeps digest pins in memory per bridge instance.
 * `umt vet` extends that story to disk: `~/.universal-mcp-toolkit/vet-pins.json`
 * records the last-seen digest (plus the tool snapshot, so drift reports can
 * name added/removed/modified tools) per server label. The first vet records
 * the pin; later vets compare and report `match` or `drift`. If the pin file
 * is missing or unreadable the report says so honestly instead of inventing
 * a status.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

import {
  vetServer,
  vetExitCode,
  type HttpVetTarget,
  type ScannableTool,
  type StdioVetTarget,
  type VetFinding,
  type VetReport,
  type VetTarget,
} from "@universal-mcp-toolkit/core";
import { digestToolsList, checkDefinitionDrift } from "@universal-mcp-toolkit/bridge";

import { getStateDirectory, readState, writeState, type AddedServer, type CliState } from "./config-store.js";
import type { ServerRegistryEntry } from "./registry.js";

/** Re-exported for `index.ts`, which resolves vet targets through this module. */
export type { VetTarget } from "@universal-mcp-toolkit/core";

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** True when the argument is an http(s) URL rather than a registry server id. */
export function isUrlTarget(arg: string): boolean {
  return /^https?:\/\//i.test(arg);
}

export function urlVetTarget(url: string): HttpVetTarget {
  return { kind: "http", label: url, url };
}

export interface StdioLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Build a stdio vet target for a registry entry from its launch config. */
export function registryStdioTarget(entry: ServerRegistryEntry, launch: StdioLaunch): StdioVetTarget {
  return {
    kind: "stdio",
    label: entry.id,
    command: launch.command,
    args: launch.args,
    ...(launch.env !== undefined ? { env: launch.env } : {}),
    ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
  };
}

// ---------------------------------------------------------------------------
// Drift-pin store (disk extension of the bridge's in-memory digest pins)
// ---------------------------------------------------------------------------

export interface VetPinRecord {
  digest: string;
  toolCount: number;
  negotiatedVersion: string | null;
  vettedAt: string;
  /** Tool snapshot so drift reports can name added/removed/modified tools. */
  tools: ScannableTool[];
}

export type VetPinStatus = "first" | "match" | "drift" | "unavailable";

export interface VetPinCheck {
  status: VetPinStatus;
  previous: VetPinRecord | null;
  current: VetPinRecord;
  drift: {
    changed: boolean;
    added: string[];
    removed: string[];
    modified: string[];
  } | null;
}

function getVetPinPath(): string {
  return path.join(getStateDirectory(), "vet-pins.json");
}

async function readVetPins(): Promise<Record<string, VetPinRecord> | null> {
  try {
    const contents = await readFile(getVetPinPath(), "utf8");
    return JSON.parse(contents) as Record<string, VetPinRecord>;
  } catch {
    return null;
  }
}

async function writeVetPins(pins: Record<string, VetPinRecord>): Promise<boolean> {
  try {
    await mkdir(getStateDirectory(), { recursive: true });
    await writeFile(getVetPinPath(), JSON.stringify(pins, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare the fresh `tools/list` digest against the recorded pin and persist
 * the new pin. Uses the bridge's `digestToolsList`/`checkDefinitionDrift`
 * machinery so the digest semantics match the runtime drift defense exactly.
 */
export async function checkAndRecordVetPin(
  label: string,
  report: VetReport,
): Promise<VetPinCheck> {
  const current: VetPinRecord = {
    digest: digestToolsList(report.tools),
    toolCount: report.tools.length,
    negotiatedVersion: report.negotiatedVersion,
    vettedAt: report.probedAt,
    tools: report.tools,
  };
  const pins = await readVetPins();
  if (pins === null) {
    const persisted = await writeVetPins({ [label]: current });
    return {
      status: persisted ? "first" : "unavailable",
      previous: null,
      current,
      drift: null,
    };
  }
  const previous = pins[label] ?? null;
  if (previous === null) {
    pins[label] = current;
    const persisted = await writeVetPins(pins);
    return {
      status: persisted ? "first" : "unavailable",
      previous: null,
      current,
      drift: null,
    };
  }
  const driftReport = checkDefinitionDrift(previous.digest, previous.tools, report.tools);
  pins[label] = current;
  await writeVetPins(pins);
  return {
    status: driftReport.changed ? "drift" : "match",
    previous,
    current,
    drift: {
      changed: driftReport.changed,
      added: driftReport.added,
      removed: driftReport.removed,
      modified: driftReport.modified,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface VetRunResult {
  report: VetReport;
  pin: VetPinCheck | null;
  exitCode: 0 | 1 | 2;
}

function severityIcon(severity: VetFinding["severity"]): string {
  switch (severity) {
    case "error":
      return chalk.red("✗");
    case "warning":
      return chalk.yellow("⚠");
    case "info":
      return chalk.blue("ℹ");
    default:
      return chalk.gray("•");
  }
}

function verdictLine(report: VetReport): string {
  const code = vetExitCode(report);
  if (code === 2) return chalk.red("✗ vet FAILED — protocol error (exit 2)");
  if (code === 1) return chalk.red("✗ vet FAILED — security findings (exit 1)");
  const warnings = report.findings.filter((f) => f.severity === "warning").length;
  return warnings > 0
    ? chalk.yellow(`⚠ vet passed with ${warnings} warning(s) (exit 0)`)
    : chalk.green("✓ vet clean (exit 0)");
}

function formatProbeMatrix(report: VetReport): string[] {
  const lines = ["  offered → negotiated"];
  for (const probe of report.probes) {
    const outcome = probe.error
      ? chalk.red(`error: ${probe.error.slice(0, 80)}`)
      : probe.accepted
        ? chalk.green(`${probe.negotiated} (accepted)`)
        : chalk.yellow(`${probe.negotiated} (downgraded)`);
    lines.push(`    ${probe.offered} → ${outcome}`);
  }
  return lines;
}

/** Human-readable report. Pure function — easy to test, no I/O. */
export function formatVetReport(run: VetRunResult): string {
  const { report, pin } = run;
  const lines: string[] = [];
  lines.push(chalk.bold(`vet ${report.target.label}`));
  lines.push(verdictLine(report));
  lines.push("");
  lines.push(chalk.bold.blue("Transport & protocol"));
  lines.push(`  transport: ${report.target.transport} — ${report.target.transportDetail}`);
  if (report.protocolError) {
    lines.push(chalk.red(`  protocol error: ${report.protocolError}`));
  } else {
    lines.push(`  negotiated: ${chalk.bold(report.negotiatedVersion ?? "unknown")}`);
    if (report.serverInfo?.name) {
      lines.push(
        `  server: ${report.serverInfo.name}${report.serverInfo.version ? ` v${report.serverInfo.version}` : ""}`,
      );
    }
    lines.push(...formatProbeMatrix(report));
    if (report.sessionId) lines.push(`  Mcp-Session-Id: issued (${report.sessionId.slice(0, 12)}…)`);
    if (report.statelessCapable !== null) {
      lines.push(
        `  stateless: ${report.statelessCapable ? chalk.green("yes — tools/list works with no session") : chalk.yellow("no — session required (2025-era stateful)")}`,
      );
    }
    if (report.observedServerRequests.length > 0) {
      lines.push(
        `  server→client requests observed: ${report.observedServerRequests.map((r) => r.method).join(", ")}`,
      );
    }
    const metaKeys = [...report.metaKeys.initialize, ...report.metaKeys.toolsList];
    if (metaKeys.length > 0) lines.push(`  _meta keys: ${metaKeys.join(", ")}`);
  }
  lines.push("");
  lines.push(chalk.bold.blue(`Security scan (${report.tools.length} tools)`));
  const securityFindings = report.findings.filter((f) => f.code.startsWith("security/"));
  if (securityFindings.length === 0) {
    lines.push(chalk.green("  ✓ no prompt-injection patterns in live tool metadata"));
  } else {
    for (const finding of securityFindings) {
      lines.push(
        `  ${severityIcon(finding.severity)} ${finding.code}${finding.tool ? ` [${finding.tool}]` : ""}: ${finding.message}`,
      );
      lines.push(chalk.gray(`      → ${finding.suggestion}`));
    }
  }
  lines.push("");
  lines.push(chalk.bold.blue("Permission-risk profile"));
  const profile = report.riskProfile;
  lines.push(
    `  highest tier: ${chalk.bold(profile.highestTier)} — ` +
      `read ${profile.byTier.read}, write ${profile.byTier.write}, ` +
      `network ${profile.byTier.network}, exec ${profile.byTier.exec}, unknown ${profile.byTier.unknown}`,
  );
  if (profile.execTools.length > 0) lines.push(chalk.red(`  exec tools: ${profile.execTools.join(", ")}`));
  if (profile.networkTools.length > 0) lines.push(chalk.yellow(`  network tools: ${profile.networkTools.join(", ")}`));
  const otherFindings = report.findings.filter(
    (f) => !f.code.startsWith("security/") && !f.code.startsWith("protocol/version-downgraded"),
  );
  if (otherFindings.length > 0) {
    lines.push("");
    lines.push(chalk.bold.blue("Other findings"));
    for (const finding of otherFindings) {
      lines.push(`  ${severityIcon(finding.severity)} ${finding.code}: ${finding.message}`);
      lines.push(chalk.gray(`      → ${finding.suggestion}`));
    }
  }
  // Surface the deprecation-window finding with the rest, not buried.
  const downgrade = report.findings.find((f) => f.code === "protocol/version-downgraded");
  if (downgrade) {
    lines.push("");
    lines.push(`  ${severityIcon(downgrade.severity)} ${downgrade.code}: ${downgrade.message}`);
    lines.push(chalk.gray(`      → ${downgrade.suggestion}`));
  }
  lines.push("");
  lines.push(chalk.bold.blue("Drift pin"));
  if (pin === null) {
    lines.push(chalk.gray("  n/a — server could not be vetted, no digest to pin"));
  } else if (pin.status === "first") {
    lines.push(`  ${chalk.green("recorded")} — first vet; digest ${pin.current.digest.slice(0, 12)}… pinned for next time`);
  } else if (pin.status === "match") {
    lines.push(`  ${chalk.green("match")} — tools/list digest unchanged since ${pin.previous?.vettedAt}`);
  } else if (pin.status === "drift") {
    lines.push(chalk.red(`  ✗ DRIFT — tools/list changed since ${pin.previous?.vettedAt}`));
    const d = pin.drift;
    if (d) {
      if (d.added.length > 0) lines.push(chalk.red(`    added: ${d.added.join(", ")}`));
      if (d.removed.length > 0) lines.push(chalk.red(`    removed: ${d.removed.join(", ")}`));
      if (d.modified.length > 0) lines.push(chalk.red(`    modified: ${d.modified.join(", ")}`));
    }
    lines.push(chalk.gray("      → If this rotation was legitimate, the new digest is now pinned. If not, investigate: a silently-rotated tools/list is the supply-chain vector."));
  } else {
    lines.push(chalk.yellow("  unavailable — pin file could not be read or written; reporting in-memory status only"));
  }
  lines.push("");
  lines.push(chalk.gray("Heuristic limits: pattern-based poisoning scan (novel phrasings pass silently), name/schema risk guessing, behavioral — not exhaustive — negotiation probing."));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `umt vet`
// ---------------------------------------------------------------------------

/**
 * Vet a resolved target end to end. Returns the exit code per the vet
 * contract (0 clean / 1 security findings / 2 protocol error).
 */
export async function runVet(target: VetTarget, options: { json?: boolean } = {}): Promise<0 | 1 | 2> {
  const report = await vetServer(target);
  const pin = report.protocolError === null ? await checkAndRecordVetPin(target.label, report) : null;
  const exitCode = vetExitCode(report);
  const run: VetRunResult = { report, pin, exitCode };
  if (options.json) {
    console.log(JSON.stringify({ ...report, driftPin: pin, exitCode }, null, 2));
  } else {
    console.log(formatVetReport(run));
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// `umt add` — register a server, with a non-blocking vet advisory
// ---------------------------------------------------------------------------

function readAddedServers(state: CliState): AddedServer[] {
  return Array.isArray(state.addedServers) ? state.addedServers : [];
}

/**
 * `umt add <server-id-or-url>`: register a server in the CLI state file.
 * Runs a vet advisory first unless `--skip-vet` — advisory only, never
 * blocking: a failed vet still registers the server, loudly.
 */
export async function runAdd(
  target: VetTarget,
  rawArg: string,
  options: { skipVet?: boolean; json?: boolean } = {},
): Promise<void> {
  let advisory: VetRunResult | null = null;
  if (!options.skipVet) {
    try {
      const report = await vetServer(target);
      const pin = report.protocolError === null ? await checkAndRecordVetPin(target.label, report) : null;
      advisory = { report, pin, exitCode: vetExitCode(report) };
    } catch (error) {
      console.log(
        chalk.yellow(
          `⚠ vet advisory skipped — vetting failed before it could report: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const id = target.kind === "stdio" ? target.label : target.url;
  const state = await readState();
  const addedServers = readAddedServers(state).filter((s) => s.id !== id);
  addedServers.unshift({
    id,
    target: rawArg,
    transport: advisory ? advisory.report.target.transport : "unknown",
    addedAt: new Date().toISOString(),
    ...(advisory
      ? {
          lastVet: {
            vettedAt: advisory.report.probedAt,
            exitCode: advisory.exitCode,
            negotiatedVersion: advisory.report.negotiatedVersion,
          },
        }
      : {}),
  });
  await writeState({ ...state, addedServers: addedServers.slice(0, 50) });

  if (options.json) {
    console.log(JSON.stringify({ added: id, advisory, skippedVet: options.skipVet === true }, null, 2));
    return;
  }
  if (advisory) {
    console.log(formatVetReport(advisory));
    console.log("");
  }
  const verdict = advisory
    ? advisory.exitCode === 0
      ? chalk.green("vet clean")
      : advisory.exitCode === 1
        ? chalk.red("vet found security findings — registered anyway (advisory only)")
        : chalk.red("vet could not reach the server — registered anyway (advisory only)")
    : chalk.gray("vet skipped (--skip-vet)");
  console.log(`${chalk.green("✓")} added '${id}' (${verdict})`);
}

// ---------------------------------------------------------------------------
// Doctor integration
// ---------------------------------------------------------------------------

/**
 * The `umt doctor --vet` sub-check: vet one server and print a compact
 * summary. Never throws — a vet failure is a doctor warning, not a doctor
 * failure.
 */
export async function runDoctorVet(target: VetTarget): Promise<void> {
  console.log(chalk.bold.blue("\nVet"));
  let report: VetReport;
  try {
    report = await vetServer(target);
  } catch (error) {
    console.log(chalk.yellow(`  ⚠ vet failed: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  const exitCode = vetExitCode(report);
  const pin = report.protocolError === null ? await checkAndRecordVetPin(target.label, report) : null;
  const status =
    exitCode === 2
      ? chalk.red("protocol error — server not vettable")
      : exitCode === 1
        ? chalk.red("security findings")
        : chalk.green("clean");
  const errors = report.findings.filter((f) => f.severity === "error").length;
  const warnings = report.findings.filter((f) => f.severity === "warning").length;
  console.log(`  ${target.label}: negotiated ${report.negotiatedVersion ?? "n/a"} — ${status} (${errors} errors, ${warnings} warnings)`);
  if (pin && pin.status === "drift") {
    console.log(chalk.red("  ✗ tools/list DRIFT vs recorded pin — investigate before trusting this server"));
  }
}
