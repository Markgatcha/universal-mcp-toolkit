/**
 * Saved-trace persistence and the `umt trace` command helpers.
 *
 * Traces recorded with `--trace` are saved as JSON under
 * `<state-dir>/traces/<trace-id>.json` (the state dir is
 * `~/.universal-mcp-toolkit` — see `config-store.ts`). They contain only
 * privacy-safe metadata: span names, durations, payload *sizes*, token
 * estimates, and cost estimates — never tool arguments or outputs.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStateDirectory } from "./config-store.js";
import type { ActiveTrace, Trace } from "@universal-mcp-toolkit/bridge";

/** Directory where finished traces are saved. */
export function getTracesDir(): string {
  return path.join(getStateDirectory(), "traces");
}

/** Save a finished trace's JSON. Returns the file path. */
export async function saveTrace(trace: ActiveTrace, finished: Trace): Promise<string> {
  const dir = getTracesDir();
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${finished.id}.json`);
  await writeFile(filePath, trace.toJson(finished), "utf8");
  return filePath;
}

/** Lightweight header for `umt trace list`. */
export interface SavedTraceSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  model: string | null;
  calls: number;
  errors: number;
  cachedHits: number;
  durationMs: number;
  costUsd: number | null;
}

/** List saved traces, newest first. */
export async function listTraces(): Promise<SavedTraceSummary[]> {
  const dir = getTracesDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  const summaries: SavedTraceSummary[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as Trace;
      if (parsed.format !== "umt-trace/1") continue;
      summaries.push({
        id: parsed.id,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        model: parsed.model,
        calls: parsed.totals.calls,
        errors: parsed.totals.errors,
        cachedHits: parsed.totals.cachedHits,
        durationMs: parsed.totals.durationMs,
        costUsd: parsed.totals.costUsd,
      });
    } catch {
      // Skip unreadable/corrupt trace files.
    }
  }
  return summaries;
}

/** Load a saved trace by ID (prefix match allowed). */
export async function loadTrace(id: string): Promise<{ trace: Trace; json: string } | null> {
  const dir = getTracesDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const match = files.find((f) => f === `${id}.json`) ?? files.find((f) => f.startsWith(id) && f.endsWith(".json"));
  if (!match) return null;
  try {
    const json = await readFile(path.join(dir, match), "utf8");
    const trace = JSON.parse(json) as Trace;
    if (trace.format !== "umt-trace/1") return null;
    return { trace, json };
  } catch {
    return null;
  }
}

/**
 * Resolve the model used for cost estimation:
 * explicit CLI flag > `UMT_TRACE_MODEL` env > built-in default.
 */
export function resolveTraceModel(cliModel?: string): string {
  return cliModel || process.env.UMT_TRACE_MODEL || "gpt-4o";
}

/**
 * Render a table of saved traces for `umt trace list`.
 */
export function renderTraceTable(summaries: readonly SavedTraceSummary[]): string {
  const header = `${"ID".padEnd(10)} ${"STARTED".padEnd(22)} ${"CALLS".padStart(5)} ${"ERR".padStart(4)} ${"TIME".padStart(8)} ${"COST(EST)"}`;
  const rows = summaries.map((s) => {
    const cost = s.costUsd !== null ? `$${s.costUsd.toFixed(6)}` : "n/a";
    return (
      `${s.id.slice(0, 8).padEnd(10)} ${s.startedAt.slice(0, 19).replace("T", " ").padEnd(22)} ` +
      `${String(s.calls).padStart(5)} ${String(s.errors).padStart(4)} ` +
      `${`${s.durationMs}ms`.padStart(8)} ${cost}`
    );
  });
  return [header, ...rows].join("\n");
}
