/**
 * MCP 2026-07-28 spec surfaces — Tasks, MRTR, cache hints, and definition-drift defense.
 *
 * The 2026-07-28 revision of the Model Context Protocol added four features
 * that UMT now supports experimentally:
 *
 * - **Tasks** (`io.modelcontextprotocol/tasks`): long-running tool calls run
 *   as pollable tasks with progress updates and cooperative cancellation.
 * - **MRTR** (multi-round-trip requests): when a tool call returns
 *   `resultType: "input_required"`, the client collects the requested inputs
 *   and retries the call with `inputResponses` until a final result arrives
 *   (or a bounded round limit is hit).
 * - **Cache hints**: `tools/list` results may advertise `ttlMs`/`cacheScope`;
 *   server-blessed TTLs replace UMT's guessed defaults.
 * - **Definition-drift defense**: `tools/list` results are digest-pinned per
 *   server; a changed digest raises an alert, since a poisoned tools/list is
 *   the supply-chain attack vector (see mcp-defense-bench) and UMT's slim
 *   manifest makes silent definition drift more consequential.
 *
 * Dual-era compatibility: every feature here is capability-detected. Servers
 * speaking the older 2025-06-18 / 2025-11-25 revisions simply report no task
 * support, no cache hints, and no MRTR fields, and UMT behaves exactly as
 * before. Nothing in this module requires 2026-07-28.
 *
 * @module @universal-mcp-toolkit/bridge/tasks
 */

import { createHash } from "node:crypto";
import type { ServerCapabilities, Task, Tool } from "@modelcontextprotocol/sdk/types.js";

/* ── Task status / feature detection ─────────────────────────────────────── */

/**
 * Task lifecycle statuses from the 2026-07-28 spec (SEP-2663).
 */
export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal task statuses — the task will not change state again. */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Return true when a task status is terminal (no further transitions).
 */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * What the connected server supports, feature-detected from its advertised
 * capabilities. All-false for pre-2026-07-28 servers (dual-era safe).
 */
export interface TaskSupport {
  /** Server supports task-augmented `tools/call` (capabilities.tasks.requests.tools.call). */
  toolsCallTasks: boolean;
  /** Server supports `tasks/list`. */
  canList: boolean;
  /** Server supports `tasks/cancel`. */
  canCancel: boolean;
}

/**
 * Feature-detect Tasks support from server capabilities.
 * Never throws — missing/older capabilities simply report no support.
 */
export function detectTaskSupport(
  capabilities: ServerCapabilities | undefined | null,
): TaskSupport {
  const tasks = capabilities?.tasks as
    | {
        list?: unknown;
        cancel?: unknown;
        requests?: { tools?: { call?: unknown } };
      }
    | undefined;
  return {
    toolsCallTasks: tasks?.requests?.tools?.call !== undefined,
    canList: tasks?.list !== undefined,
    canCancel: tasks?.cancel !== undefined,
  };
}

/** Convenience re-export of the SDK's Task shape for bridge consumers. */
export type { Task as McpTask };

/* ── MRTR (multi-round-trip requests) ────────────────────────────────────── */

/**
 * One input request inside an `input_required` result.
 * `method` is the logical method the server needed mid-execution, e.g.
 * `elicitation/create`; `params` carries its parameters.
 */
export interface MrtrInputRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** Input requests keyed by the server's opaque request key. */
export type MrtrInputRequests = Record<string, MrtrInputRequest>;

/** Client answers, keyed to match `inputRequests`. */
export type MrtrInputResponses = Record<string, unknown>;

/**
 * The wire shape of an MRTR `input_required` result (2026-07-28).
 * `requestState` is opaque — clients must echo it back byte-exact and must
 * never inspect or modify it.
 */
export interface InputRequiredResultShape {
  resultType: "input_required";
  inputRequests: MrtrInputRequests;
  requestState?: string;
}

/**
 * Return true when a raw tool-call result is an MRTR `input_required` result.
 * Older servers never set `resultType`, so this is dual-era safe.
 */
export function isInputRequiredResult(
  raw: unknown,
): raw is InputRequiredResultShape {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as { resultType?: unknown; inputRequests?: unknown };
  return (
    candidate.resultType === "input_required" &&
    typeof candidate.inputRequests === "object" &&
    candidate.inputRequests !== null
  );
}

/** Extract `inputRequests`/`requestState` from a verified input_required result. */
export function extractInputRequired(raw: InputRequiredResultShape): {
  inputRequests: MrtrInputRequests;
  requestState?: string;
} {
  return {
    inputRequests: raw.inputRequests,
    requestState: raw.requestState,
  };
}

/** Error thrown when the MRTR round limit is exceeded. */
export class MrtrRoundLimitError extends Error {
  readonly rounds: number;
  readonly lastInputRequests: MrtrInputRequests;

  constructor(rounds: number, lastInputRequests: MrtrInputRequests) {
    super(
      `MRTR round limit exceeded after ${rounds} rounds: the server kept ` +
        `requesting input. Last inputRequests keys: ${Object.keys(lastInputRequests).join(", ") || "(none)"}. ` +
        `Increase maxRounds if the flow legitimately needs more rounds.`,
    );
    this.name = "MrtrRoundLimitError";
    this.rounds = rounds;
    this.lastInputRequests = lastInputRequests;
  }
}

/** Error thrown when a server requests MRTR input but no input handler was provided. */
export class MrtrInputRequiredError extends Error {
  readonly inputRequests: MrtrInputRequests;

  constructor(inputRequests: MrtrInputRequests) {
    super(
      `Server returned resultType "input_required" but no input handler was ` +
        `provided. Requested inputs: ${Object.keys(inputRequests).join(", ") || "(none)"}. ` +
        `Pass onInputRequest to answer the server's input requests.`,
    );
    this.name = "MrtrInputRequiredError";
    this.inputRequests = inputRequests;
  }
}

/** Default cap on MRTR rounds — bounds a misbehaving server's input loop. */
export const DEFAULT_MRTR_MAX_ROUNDS = 8;

/** Options for {@link runMultiRoundTrip}. */
export interface MultiRoundTripOptions {
  /**
   * Maximum number of `input_required` rounds before giving up.
   * Default: 8. Each round is one full retry of the original call.
   */
  maxRounds?: number;
  /**
   * Collect answers for the server's input requests. Called once per
   * `input_required` round with the requests and the 1-based round number.
   * If omitted, the first `input_required` result throws MrtrInputRequiredError.
   */
  onInputRequest?: (
    inputRequests: MrtrInputRequests,
    round: number,
  ) => Promise<MrtrInputResponses>;
}

/**
 * Run the MRTR loop: invoke `call`, and while the result is
 * `resultType: "input_required"`, collect answers via `onInputRequest` and
 * retry with `inputResponses` (+ echoed `requestState`) until a final result
 * arrives or `maxRounds` is exceeded.
 *
 * The `call` callback performs one wire round: it receives the (possibly
 * augmented) call arguments and the MRTR envelope for this round.
 *
 * @returns The final (non-`input_required`) raw result and the round count
 *   (1 = the server answered immediately).
 */
export async function runMultiRoundTrip<T>(
  call: (
    args: Record<string, unknown>,
    mrtr: { inputResponses?: MrtrInputResponses; requestState?: string },
  ) => Promise<T>,
  initialArgs: Record<string, unknown>,
  options: MultiRoundTripOptions = {},
): Promise<{ result: T; rounds: number }> {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MRTR_MAX_ROUNDS);
  let inputResponses: MrtrInputResponses | undefined;
  let requestState: string | undefined;
  let rounds = 0;

  for (;;) {
    rounds += 1;
    const raw = await call(initialArgs, { inputResponses, requestState });
    if (!isInputRequiredResult(raw)) {
      return { result: raw, rounds };
    }
    if (rounds >= maxRounds) {
      throw new MrtrRoundLimitError(rounds, raw.inputRequests);
    }
    if (!options.onInputRequest) {
      throw new MrtrInputRequiredError(raw.inputRequests);
    }
    const { inputRequests, requestState: nextState } = extractInputRequired(raw);
    // Echo requestState back byte-exact on the retry (spec requirement).
    requestState = nextState;
    inputResponses = await options.onInputRequest(inputRequests, rounds);
  }
}

/* ── Cache hints ─────────────────────────────────────────────────────────── */

/**
 * Server-advertised caching guidance from a list result (SEP-2549).
 * `tools/list`, `prompts/list`, `resources/list`, etc. may carry these.
 */
export interface CacheHint {
  /** Server-blessed TTL in milliseconds. */
  ttlMs?: number;
  /** "public" (shared caches OK) or "private" (per-client only). */
  cacheScope?: "public" | "private";
}

/**
 * Extract `ttlMs`/`cacheScope` from a raw list result.
 * Returns an empty hint when the server advertises nothing (dual-era safe).
 * Invalid values are ignored rather than honored.
 */
export function extractCacheHint(listResult: unknown): CacheHint {
  const hint: CacheHint = {};
  if (typeof listResult !== "object" || listResult === null) return hint;
  const candidate = listResult as { ttlMs?: unknown; cacheScope?: unknown };
  if (
    typeof candidate.ttlMs === "number" &&
    Number.isFinite(candidate.ttlMs) &&
    candidate.ttlMs > 0
  ) {
    hint.ttlMs = Math.floor(candidate.ttlMs);
  }
  if (candidate.cacheScope === "public" || candidate.cacheScope === "private") {
    hint.cacheScope = candidate.cacheScope;
  }
  return hint;
}

/* ── Definition-drift defense ────────────────────────────────────────────── */

/**
 * Canonicalize a value with sorted object keys for stable digests.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

/** The security-relevant surface of one tool definition for digest pinning. */
export interface DigestibleToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

function toDigestible(tool: Tool | DigestibleToolDefinition): DigestibleToolDefinition {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...("inputSchema" in tool && tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...("annotations" in tool &&
    (tool as { annotations?: unknown }).annotations !== undefined
      ? { annotations: (tool as { annotations?: unknown }).annotations }
      : {}),
  };
}

/**
 * Digest-pin a `tools/list` result: SHA-256 over the canonicalized,
 * name-sorted tool definitions (name, title, description, inputSchema,
 * annotations). Any silent server-side change to a definition — the
 * supply-chain vector measured by mcp-defense-bench — changes the digest.
 */
export function digestToolsList(
  tools: Array<Tool | DigestibleToolDefinition>,
): string {
  const digestible = tools.map(toDigestible).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(digestible)))
    .digest("hex");
}

/** Result of comparing two pinned `tools/list` snapshots. */
export interface DefinitionDriftReport {
  /** True when the definitions changed between pins. */
  changed: boolean;
  previousDigest: string;
  currentDigest: string;
  /** Tool names present now but not before. */
  added: string[];
  /** Tool names present before but not now. */
  removed: string[];
  /** Tool names present in both whose definition digest changed. */
  modified: string[];
}

/**
 * Compare a previously pinned `tools/list` against a fresh one.
 * Returns per-name added/removed/modified sets plus the digests.
 */
export function checkDefinitionDrift(
  previousDigest: string,
  previousTools: Array<Tool | DigestibleToolDefinition>,
  currentTools: Array<Tool | DigestibleToolDefinition>,
): DefinitionDriftReport {
  const currentDigest = digestToolsList(currentTools);
  const prevByName = new Map(previousTools.map((t) => [t.name, digestToolsList([t])]));
  const currByName = new Map(currentTools.map((t) => [t.name, digestToolsList([t])]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const name of currByName.keys()) {
    if (!prevByName.has(name)) added.push(name);
    else if (prevByName.get(name) !== currByName.get(name)) modified.push(name);
  }
  for (const name of prevByName.keys()) {
    if (!currByName.has(name)) removed.push(name);
  }

  return {
    changed: currentDigest !== previousDigest,
    previousDigest,
    currentDigest,
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
  };
}

/* ── Task progress / spawn option types (bridge API surface) ─────────────── */

/** Options for spawning a long-running tool call as a task. */
export interface TaskSpawnOptions {
  /**
   * Requested task retention in ms (task `ttl`). How long the server keeps
   * the task after creation.
   */
  ttlMs?: number;
  /** Hint to the server for how often to poll for status (ms). */
  pollIntervalMs?: number;
  /** Overall timeout for the initial spawn request (ms). */
  timeoutMs?: number;
}

/** Options for awaiting a task to completion. */
export interface TaskAwaitOptions {
  /** Called with every polled task state (progress updates). */
  onProgress?: (task: Task) => void;
  /** Overall timeout for awaiting completion (ms). Default: none. */
  timeoutMs?: number;
  /** Fallback poll interval when the server advertises none (ms). Default: 1000. */
  pollIntervalMs?: number;
}

/** Options for cancelling a task. */
export interface TaskCancelOptions {
  /**
   * When true (default), cancel child tasks linked via `linkTaskChild`
   * before cancelling this task — a cancellation cascade.
   */
  cascade?: boolean;
}

/* ── Bridge events ───────────────────────────────────────────────────────── */

/**
 * Emitted when a freshly fetched `tools/list` no longer matches the pinned
 * digest for the server. A poisoned or silently-rotated tools/list is the
 * supply-chain attack vector (see mcp-defense-bench); UMT's slim manifest
 * makes undetected definition drift more consequential, so this is loud.
 */
export interface DefinitionDriftEvent extends DefinitionDriftReport {
  /** Human-readable server label, e.g. `stdio:npx`. */
  serverLabel: string;
  /** ISO timestamp of the fetch that detected the drift. */
  fetchedAt: string;
  /** Cache hint advertised alongside the drifting listing (if any). */
  cacheHint: CacheHint;
}

/** Events the bridge can emit. */
export type BridgeEventName = "definition-drift";

/** Listener for {@link DefinitionDriftEvent}. */
export type DefinitionDriftListener = (event: DefinitionDriftEvent) => void;
