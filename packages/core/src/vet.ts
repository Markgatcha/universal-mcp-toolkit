/**
 * `umt vet` — live MCP spec-conformance + security vetting of a running server.
 *
 * mcp-vet (npm, Sept 2026) only scans server *source* against static protocol
 * rules. This module does the opposite: it probes what a *running* server
 * actually negotiates over the wire, then scans the live `tools/list` for
 * prompt-injection and permission risk. No LLM anywhere — every check is a
 * deterministic probe or a fixed pattern set.
 *
 * What gets probed:
 * - **Protocol negotiation**: a fresh `initialize` is sent for each known
 *   `protocolVersion` (newest first). The negotiated version the server
 *   answers with is recorded, so the report shows exactly which spec
 *   revisions the server accepts — e.g. "offers 2026-07-28, negotiates
 *   2025-06-18".
 * - **Transport detection**: for URL targets, Streamable HTTP is tried first
 *   (POST `initialize`); a legacy SSE handshake (`GET` → `event: endpoint`)
 *   is the fallback. stdio targets spawn the command directly.
 * - **`Mcp-Session-Id` behavior**: on Streamable HTTP, whether the server
 *   issues a session id (stateful, 2025-era) and whether `tools/list`
 *   succeeds *without* one (stateless, 2026-07-28 style).
 * - **Deprecated primitives**: server→client `sampling/createMessage` or
 *   `roots/list` requests observed during the session are flagged — under
 *   2026-07-28 both moved to the MRTR extension.
 * - **`_meta` inspection**: `_meta` keys on the `initialize` and
 *   `tools/list` results are surfaced (some servers smuggle auth or routing
 *   hints there).
 * - **Tool poisoning**: every tool's name/description/inputSchema is scanned
 *   against a fixed prompt-injection pattern set (instruction overrides,
 *   system-prompt theft, role hijack, exfiltration directives, credential
 *   harvesting, suspicious URLs, obfuscated blobs).
 * - **Permission-risk tiering**: each tool is classified read/write/network/
 *   exec from its MCP annotations, name, and schema properties, and an
 *   aggregate risk profile is reported.
 *
 * Honest limitations (read before trusting a clean report):
 * - Negotiation probing is behavioral, not exhaustive: a server may accept a
 *   version string it then only half-implements. The report shows what was
 *   *negotiated*, not a full conformance suite.
 * - The poisoning scan is pattern-based. A novel phrasing it doesn't know
 *   passes silently, and generic words ("send", "url") only fire when shaped
 *   like an exfiltration directive — expect both false negatives and the
 *   occasional false positive on legitimately network-y tools.
 * - Risk tiering is heuristic: `annotations` are server-declared and may lie;
 *   name/schema guessing catches the common cases, not novel ones.
 * - Servers that can't be probed live (need OAuth, mTLS, interactive login,
 *   or a non-JSONRPC transport) fail closed with a protocol error, not a
 *   clean bill of health.
 * - stdio probing spawns one process per candidate version; slow or
 *   interactive servers may time out and be reported as unreachable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Spec revisions `umt vet` knows how to offer, newest first. */
export const KNOWN_PROTOCOL_VERSIONS: readonly string[] = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The newest revision whose deprecation window is ticking. */
export const CURRENT_SPEC_REVISION = "2026-07-28";

/** Default per-request timeout for wire probes. */
export const DEFAULT_VET_TIMEOUT_MS = 8000;

/** How long to keep the vetted session open watching for server→client requests. */
export const DEFAULT_OBSERVATION_WINDOW_MS = 750;

const CLIENT_NAME = "umt-vet";

// ---------------------------------------------------------------------------
// Targets & channels
// ---------------------------------------------------------------------------

/** A stdio server: spawned once per probe so probes can't contaminate each other. */
export interface StdioVetTarget {
  kind: "stdio";
  /** Human label shown in reports (server id, command line, …). */
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A remote server reached over HTTP(S). Transport is auto-detected. */
export interface HttpVetTarget {
  kind: "http";
  /** Human label shown in reports (usually the URL). */
  label: string;
  url: string;
  headers?: Record<string, string>;
}

export type VetTarget = StdioVetTarget | HttpVetTarget;

export type VetTransportKind = "stdio" | "streamable-http" | "sse" | "unknown";

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface VetRequestResult {
  result?: unknown;
  error?: JsonRpcErrorShape;
  /** Lower-cased response headers (HTTP channels only). */
  responseHeaders?: Record<string, string>;
}

export interface ObservedServerRequest {
  method: string;
  params: unknown;
  at: string;
}

/**
 * A raw JSON-RPC channel to the server under test. Deliberately *not* the
 * SDK `Client`: the SDK always initializes with its own latest version, which
 * is exactly the behavior we need to override per probe.
 */
export interface VetChannel {
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<VetRequestResult>;
  notify(method: string, params?: unknown): void;
  /** Server→client requests seen on this channel (sampling, roots, …). */
  observedServerRequests: ObservedServerRequest[];
  close(): Promise<void>;
}

export type VetChannelFactory = () => Promise<VetChannel>;

interface PendingRequest {
  resolve: (value: VetRequestResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Route one inbound JSON-RPC message: response → pending, request → observe + reject. */
function routeInbound(
  channel: { observedServerRequests: ObservedServerRequest[] },
  pending: Map<number | string, PendingRequest>,
  respond: (id: number | string, error: JsonRpcErrorShape) => void,
  message: unknown,
): void {
  if (!isRecord(message) || message["jsonrpc"] !== "2.0") return;
  const id = message["id"];
  if ((typeof id === "number" || typeof id === "string") && pending.has(id)) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in message && isRecord(message["error"])) {
      const errObj = message["error"] as Record<string, unknown>;
      entry.resolve({
        error: {
          code: typeof errObj["code"] === "number" ? errObj["code"] : -32603,
          message: typeof errObj["message"] === "string" ? errObj["message"] : "Unknown error",
          ...(errObj["data"] !== undefined ? { data: errObj["data"] } : {}),
        },
      });
    } else {
      entry.resolve({ result: message["result"] });
    }
    return;
  }
  if (typeof message["method"] === "string" && id !== undefined) {
    // Server→client request: record it, then decline — the vet client offers
    // no sampling/roots capability, so any such request is itself a signal.
    channel.observedServerRequests.push({
      method: message["method"],
      params: message["params"],
      at: new Date().toISOString(),
    });
    if (typeof id === "number" || typeof id === "string") {
      respond(id, { code: -32601, message: `umt-vet does not implement ${message["method"]}` });
    }
  }
  // Notifications and stray messages are ignored.
}

function failPending(pending: Map<number | string, PendingRequest>, error: Error): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

// ---------------------------------------------------------------------------
// stdio channel
// ---------------------------------------------------------------------------

/** Raw newline-delimited JSON-RPC over a spawned process's stdio. */
export class StdioVetChannel implements VetChannel {
  observedServerRequests: ObservedServerRequest[] = [];

  private readonly proc: ChildProcess;
  private readonly pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    proc.on("error", (error) => {
      if (!this.closed) failPending(this.pending, error);
    });
    proc.on("exit", () => {
      if (!this.closed) {
        failPending(this.pending, new Error("Server process exited during vetting."));
      }
    });
  }

  static spawn(target: StdioVetTarget): StdioVetChannel {
    const proc = spawn(target.command, target.args ?? [], {
      env: { ...process.env, ...(target.env ?? {}) },
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new StdioVetChannel(proc);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Non-JSON stdout (log lines) is not our protocol.
      }
      routeInbound(this, this.pending, (id, error) => this.write({ jsonrpc: "2.0", id, error }), message);
    }
  }

  private write(message: unknown): void {
    if (this.closed) return;
    this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<VetRequestResult> {
    if (this.closed) throw new Error("Channel is closed.");
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_VET_TIMEOUT_MS;
    return new Promise<VetRequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async close(): Promise<void> {
    this.closed = true;
    failPending(this.pending, new Error("Channel closed."));
    this.proc.stdin?.end();
    if (!this.proc.killed) this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP channel
// ---------------------------------------------------------------------------

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Split a `text/event-stream` body into its `data:` payloads. */
function parseSseDataPayloads(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    try {
      payloads.push(JSON.parse(dataLines.join("\n")));
    } catch {
      // Non-JSON SSE data (pings, comments) is ignored.
    }
  }
  return payloads;
}

/** Raw JSON-RPC over Streamable HTTP: one POST per message, session via `Mcp-Session-Id`. */
export class StreamableHttpVetChannel implements VetChannel {
  observedServerRequests: ObservedServerRequest[] = [];

  private sessionId: string | undefined;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async post(body: unknown, timeoutMs: number): Promise<VetRequestResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.headers,
      };
      if (this.sessionId !== undefined) requestHeaders["mcp-session-id"] = this.sessionId;
      const response = await fetch(this.url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseHeaders = lowerCaseHeaders(response.headers);
      const sessionId = responseHeaders["mcp-session-id"];
      if (sessionId !== undefined && sessionId.length > 0) this.sessionId = sessionId;
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      if (!response.ok) {
        return {
          responseHeaders,
          error: { code: -32000, message: `HTTP ${response.status}: ${text.slice(0, 200)}` },
        };
      }
      const payloads = contentType.includes("text/event-stream")
        ? parseSseDataPayloads(text)
        : [safeJsonParse(text)];
      const bodyId = isRecord(body) ? body["id"] : undefined;
      const match =
        payloads.find(
          (p) => isRecord(p) && (typeof p["id"] === "number" || typeof p["id"] === "string") && p["id"] === bodyId,
        ) ??
        payloads.find((p) => isRecord(p) && ("result" in p || "error" in p));
      if (!isRecord(match)) {
        return { responseHeaders, error: { code: -32603, message: "Empty or unparsable response body." } };
      }
      // Server→client requests can ride along in SSE response streams; observe them.
      for (const p of payloads) {
        if (isRecord(p) && typeof p["method"] === "string" && p["id"] !== undefined) {
          this.observedServerRequests.push({
            method: p["method"],
            params: p["params"],
            at: new Date().toISOString(),
          });
        }
      }
      if ("error" in match && isRecord(match["error"])) {
        const errObj = match["error"] as Record<string, unknown>;
        return {
          responseHeaders,
          error: {
            code: typeof errObj["code"] === "number" ? errObj["code"] : -32603,
            message: typeof errObj["message"] === "string" ? errObj["message"] : "Unknown error",
          },
        };
      }
      return { responseHeaders, result: match["result"] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: { code: -32000, message: `Transport failure: ${message}` } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The session id issued by the server on this channel, if any. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<VetRequestResult> {
    const id = Math.floor(Math.random() * 2 ** 31);
    return this.post({ jsonrpc: "2.0", id, method, params: params ?? {} }, opts?.timeoutMs ?? DEFAULT_VET_TIMEOUT_MS);
  }

  notify(method: string, params?: unknown): void {
    void this.post(
      { jsonrpc: "2.0", method, params: params ?? {} },
      DEFAULT_VET_TIMEOUT_MS,
    );
  }

  async close(): Promise<void> {
    // Stateless per-request POSTs: nothing persistent to tear down.
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Legacy SSE channel (2024-11-05 / 2025-03-26 era transport)
// ---------------------------------------------------------------------------

/**
 * Minimal client for the legacy SSE transport: `GET` the SSE endpoint, read
 * the `event: endpoint` handshake, POST JSON-RPC to the announced message
 * endpoint, and route `event: message` responses back to pending requests.
 */
export class SseVetChannel implements VetChannel {
  observedServerRequests: ObservedServerRequest[] = [];

  private readonly pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private messageEndpoint: string | undefined;
  private handshakeError: Error | undefined;
  private readonly handshakeDone: Promise<void>;
  private readerClosed = false;

  private constructor(
    private readonly sseUrl: string,
    private readonly headers: Record<string, string>,
  ) {
    this.handshakeDone = this.runHandshake();
  }

  static async connect(sseUrl: string, headers: Record<string, string> = {}): Promise<SseVetChannel> {
    const channel = new SseVetChannel(sseUrl, headers);
    await channel.handshakeDone;
    return channel;
  }

  private async runHandshake(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.sseUrl, {
        method: "GET",
        headers: { accept: "text/event-stream", ...this.headers },
      });
    } catch (error) {
      this.handshakeError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    if (!response.ok || !response.body) {
      this.handshakeError = new Error(`SSE handshake failed: HTTP ${response.status}.`);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.onSseEvent(rawEvent);
            if (this.readerClosed) return;
          }
        }
      } catch {
        // Stream errors surface as pending-request timeouts; nothing to do.
      } finally {
        reader.releaseLock();
      }
    };
    // Wait for the endpoint event (or failure) before resolving the handshake.
    const endpointPromise = new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (this.messageEndpoint !== undefined) {
          clearInterval(check);
          resolve();
        } else if (this.handshakeError !== undefined) {
          clearInterval(check);
          reject(this.handshakeError);
        }
      }, 25);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error("Timed out waiting for the SSE endpoint event."));
      }, DEFAULT_VET_TIMEOUT_MS);
    });
    void pump();
    await endpointPromise;
  }

  private onSseEvent(rawEvent: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    if (event === "endpoint") {
      const endpoint = dataLines.join("\n").trim();
      if (endpoint.length > 0) {
        try {
          this.messageEndpoint = new URL(endpoint, this.sseUrl).toString();
        } catch {
          this.handshakeError = new Error(`Invalid SSE endpoint URL: ${endpoint}`);
        }
      }
      return;
    }
    if (dataLines.length === 0) return;
    const payload = safeJsonParse(dataLines.join("\n"));
    routeInbound(this, this.pending, () => undefined, payload);
  }

  async request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<VetRequestResult> {
    await this.handshakeDone;
    if (this.handshakeError) throw this.handshakeError;
    if (this.messageEndpoint === undefined) throw new Error("SSE message endpoint unknown.");
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_VET_TIMEOUT_MS;
    const posted = await (async (): Promise<VetRequestResult | undefined> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(this.messageEndpoint as string, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
          signal: controller.signal,
        });
        if (!response.ok && response.status !== 202) {
          const text = await response.text().catch(() => "");
          return { error: { code: -32000, message: `HTTP ${response.status}: ${text.slice(0, 200)}` } };
        }
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: { code: -32000, message: `Transport failure: ${message}` } };
      } finally {
        clearTimeout(timer);
      }
    })();
    if (posted !== undefined) return posted;
    return new Promise<VetRequestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    void (async () => {
      try {
        await this.handshakeDone;
        if (this.messageEndpoint === undefined) return;
        await fetch(this.messageEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
        });
      } catch {
        // Notifications are fire-and-forget.
      }
    })();
  }

  async close(): Promise<void> {
    this.readerClosed = true;
    failPending(this.pending, new Error("Channel closed."));
  }
}

// ---------------------------------------------------------------------------
// Transport detection (URL targets)
// ---------------------------------------------------------------------------

export interface TransportDetection {
  transport: VetTransportKind;
  detail: string;
}

/**
 * Detect which MCP transport a URL speaks. Streamable HTTP is tried first
 * (a real `initialize` POST); the legacy SSE handshake is the fallback.
 * Returns `unknown` — never throws — when nothing MCP-shaped answers.
 */
export async function detectHttpTransport(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs: number = DEFAULT_VET_TIMEOUT_MS,
): Promise<TransportDetection> {
  // Attempt 1: Streamable HTTP — POST initialize, accept JSON or SSE stream.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: CURRENT_SPEC_REVISION,
            capabilities: {},
            clientInfo: { name: CLIENT_NAME, version: "0.0.0" },
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      const payloads = contentType.includes("text/event-stream")
        ? parseSseDataPayloads(text)
        : [safeJsonParse(text)];
      const looksMcp = payloads.some(
        (p) => isRecord(p) && ("result" in p || "error" in p),
      );
      if (looksMcp) {
        return {
          transport: "streamable-http",
          detail: `POST initialize answered HTTP ${response.status} with a JSON-RPC payload (${contentType.includes("text/event-stream") ? "SSE stream" : "single JSON body"}).`,
        };
      }
      return {
        transport: "unknown",
        detail: `POST initialize answered HTTP ${response.status} but the body was not JSON-RPC.`,
      };
    }
    // Non-2xx: fall through to the SSE attempt, but remember the status.
    const postStatus = response.status;
    void postStatus;
  } catch {
    // Fetch-level failure: fall through to SSE.
  }

  // Attempt 2: legacy SSE — GET with an event-stream Accept, look for `event: endpoint`.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawEndpoint = false;
      const deadline = Date.now() + Math.min(timeoutMs, 4000);
      try {
        for (;;) {
          if (Date.now() > deadline) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes("event: endpoint")) {
            sawEndpoint = true;
            break;
          }
          if (buffer.length > 65536) break;
        }
      } finally {
        reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (sawEndpoint) {
        return {
          transport: "sse",
          detail: "GET with Accept: text/event-stream yielded an `event: endpoint` handshake — legacy SSE transport.",
        };
      }
      return {
        transport: "unknown",
        detail: "GET returned an event stream but no `event: endpoint` handshake.",
      };
    }
    return {
      transport: "unknown",
      detail: `No MCP transport detected (POST initialize → non-2xx, SSE GET → HTTP ${response.status}).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { transport: "unknown", detail: `No MCP transport detected: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Protocol negotiation probing
// ---------------------------------------------------------------------------

export interface ProtocolProbe {
  offered: string;
  /** The version the server negotiated, when the probe got a result. */
  negotiated: string | null;
  /** True when the server negotiated exactly the offered version. */
  accepted: boolean;
  /** JSON-RPC or transport error text when the probe failed. */
  error: string | null;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, unknown> | null;
  /** `_meta` keys on the initialize result. */
  metaKeys: string[];
  /** `Mcp-Session-Id` response header, when the transport issued one. */
  sessionId: string | null;
}

function initializeParams(protocolVersion: string): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "0.0.0" },
  };
}

function extractMetaKeys(result: unknown): string[] {
  if (isRecord(result) && isRecord(result["_meta"])) {
    return Object.keys(result["_meta"] as Record<string, unknown>).sort();
  }
  return [];
}

/**
 * Probe one protocol version over a fresh channel. The channel is closed
 * before returning; callers that need a live session open their own.
 */
export async function probeProtocolVersion(
  factory: VetChannelFactory,
  protocolVersion: string,
  timeoutMs: number = DEFAULT_VET_TIMEOUT_MS,
): Promise<ProtocolProbe> {
  const base: Omit<ProtocolProbe, "negotiated" | "accepted" | "error" | "serverInfo" | "capabilities" | "metaKeys" | "sessionId"> = {
    offered: protocolVersion,
  };
  let channel: VetChannel | undefined;
  try {
    channel = await factory();
  } catch (error) {
    return {
      ...base,
      negotiated: null,
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
      serverInfo: null,
      capabilities: null,
      metaKeys: [],
      sessionId: null,
    };
  }
  try {
    const response = await channel.request("initialize", initializeParams(protocolVersion), { timeoutMs });
    if (response.error) {
      return {
        ...base,
        negotiated: null,
        accepted: false,
        error: `JSON-RPC ${response.error.code}: ${response.error.message}`,
        serverInfo: null,
        capabilities: null,
        metaKeys: [],
        sessionId: response.responseHeaders?.["mcp-session-id"] ?? null,
      };
    }
    const result = response.result;
    const negotiated =
      isRecord(result) && typeof result["protocolVersion"] === "string"
        ? (result["protocolVersion"] as string)
        : null;
    const serverInfoRaw = isRecord(result) ? result["serverInfo"] : undefined;
    const capabilitiesRaw = isRecord(result) ? result["capabilities"] : undefined;
    channel.notify("notifications/initialized", {});
    return {
      ...base,
      negotiated,
      accepted: negotiated === protocolVersion,
      error: null,
      serverInfo:
        isRecord(serverInfoRaw)
          ? {
              ...(typeof serverInfoRaw["name"] === "string" ? { name: serverInfoRaw["name"] as string } : {}),
              ...(typeof serverInfoRaw["version"] === "string" ? { version: serverInfoRaw["version"] as string } : {}),
            }
          : null,
      capabilities: isRecord(capabilitiesRaw) ? (capabilitiesRaw as Record<string, unknown>) : null,
      metaKeys: extractMetaKeys(result),
      sessionId: response.responseHeaders?.["mcp-session-id"] ?? null,
    };
  } catch (error) {
    return {
      ...base,
      negotiated: null,
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
      serverInfo: null,
      capabilities: null,
      metaKeys: [],
      sessionId: null,
    };
  } finally {
    await channel.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Tool-poisoning scan (deterministic pattern set, no LLM)
// ---------------------------------------------------------------------------

export type VetSeverity = "error" | "warning" | "info";

export interface VetFinding {
  severity: VetSeverity;
  /** Machine-readable code, e.g. `security/tool-poisoning/instruction-override`. */
  code: string;
  /** Tool name when the finding is tool-scoped. */
  tool?: string;
  message: string;
  /** Short actionable remediation. */
  suggestion: string;
}

interface PoisonPattern {
  id: string;
  severity: "error" | "warning";
  pattern: RegExp;
  message: string;
  suggestion: string;
}

/**
 * Fixed prompt-injection pattern set for live tool metadata. High-confidence
 * instruction-override / exfiltration shapes are errors; weaker signals
 * (bare URLs, obfuscated blobs, secrecy pleas) are warnings. Deliberately
 * narrow: a novel phrasing passes silently (documented limitation), and each
 * pattern is anchored to injection-shaped language to keep false positives
 * low on legitimately network-y tools.
 */
const TOOL_POISON_PATTERNS: PoisonPattern[] = [
  {
    id: "instruction-override",
    severity: "error",
    pattern: /\bignore\s+(all\s+|any\s+)?(previous|prior|earlier|above|preceding|past)\s+(instructions?|prompts?|directives?|rules?|guidelines?)\b/i,
    message: "Tool metadata instructs the model to ignore previous instructions.",
    suggestion:
      "Remove the override directive from the tool description. A tool must never tell the model to disregard system instructions — that is the canonical prompt-injection shape.",
  },
  {
    id: "instruction-override-verb",
    severity: "error",
    pattern: /\b(disregard|override|bypass|circumvent)\b[^.\n]{0,60}\b(system\s+)?instructions?\b/i,
    message: "Tool metadata tells the model to disregard or bypass instructions.",
    suggestion:
      "Reword the description to describe what the tool *does*, not what the model should *obey*. Any instruction-bypass language is a poisoning vector.",
  },
  {
    id: "system-prompt-theft",
    severity: "error",
    pattern: /\b(reveal|disclose|print|output|show|dump|repeat)\b[^.\n]{0,60}\b(system\s+prompt|your\s+(system\s+)?instructions|initial\s+instructions)\b/i,
    message: "Tool metadata solicits disclosure of the system prompt or instructions.",
    suggestion:
      "Delete the disclosure request. Tools that ask the model to reveal its instructions are exfiltration primitives, not documentation.",
  },
  {
    id: "role-hijack",
    severity: "error",
    pattern: /\byou\s+are\s+now\b|\bpretend\s+(you\s+are|to\s+be)\b|\bact\s+as\s+if\s+you\s+(were|are)\b/i,
    message: "Tool metadata attempts a role hijack ('you are now …').",
    suggestion:
      "Remove the role-reassignment language. Tool descriptions must not redefine the assistant's identity or role.",
  },
  {
    id: "jailbreak-token",
    severity: "error",
    pattern: /\bjail ?break\b|\bDAN\s+mode\b|\bdeveloper\s+mode\b|\bdo\s+anything\s+now\b/i,
    message: "Tool metadata contains jailbreak marker language.",
    suggestion:
      "Remove the jailbreak marker. Its presence in tool metadata is a strong poisoning indicator regardless of intent.",
  },
  {
    id: "exfiltration-directive",
    severity: "error",
    pattern:
      /\b(send|transmit|upload|forward|exfiltrate|leak|copy|post)\b[^.\n]{0,80}?\b(external|remote|third[- ]party)\b[^.\n]{0,40}?\b(url|endpoint|webhook|server|address)\b/i,
    message: "Tool metadata directs data toward an external URL/endpoint.",
    suggestion:
      "Verify the destination is the tool's documented purpose. If the tool genuinely posts outward, name the exact allowlisted endpoint; otherwise remove the directive.",
  },
  {
    id: "credential-harvest",
    severity: "error",
    pattern:
      /\b(provide|enter|supply|give|paste|include)\b[^.\n]{0,40}?\byour\b[^.\n]{0,24}?\b(password|api[_\s-]?key|secret|private\s+key|auth(entication)?\s+token)\b/i,
    message: "Tool metadata asks the caller to supply a credential in tool input.",
    suggestion:
      "Never collect raw credentials through tool arguments — use the client's secret store or OAuth flow. Rewrite the schema to take a reference, not a value.",
  },
  {
    id: "suspicious-url",
    severity: "warning",
    pattern: /https?:\/\/[^\s"'<>)\]]+/i,
    message: "Tool metadata contains a URL.",
    suggestion:
      "Confirm the URL is the tool's own documentation or allowlisted endpoint. URLs in tool descriptions are a classic exfiltration / phishing carrier.",
  },
  {
    id: "non-loopback-http",
    severity: "warning",
    pattern: /\bhttp:\/\/(?!localhost\b|127\.0\.0\.1\b|::1\b)[^\s"'<>)\]]+/i,
    message: "Tool metadata references a non-loopback plain-HTTP URL.",
    suggestion: "Prefer https:// or a loopback address. Plain HTTP to a remote host leaks whatever the tool sends.",
  },
  {
    id: "obfuscated-blob",
    severity: "warning",
    pattern: /[A-Za-z0-9+/]{120,}={0,2}/,
    message: "Tool metadata contains a long base64-looking blob.",
    suggestion:
      "Check what the blob decodes to. Obfuscated blobs in tool metadata can hide injected instructions from casual review.",
  },
  {
    id: "secrecy-plea",
    severity: "warning",
    pattern: /\b(do\s+not\s+(tell|reveal|mention|disclose|inform)\s+(the\s+user|anyone))|(keep\s+this\s+(secret|hidden|confidential))\b/i,
    message: "Tool metadata asks the model to keep something from the user.",
    suggestion:
      "Remove the secrecy language. A tool that hides its behavior from the user defeats auditability — disclose, don't conceal.",
  },
];

/** The security-relevant surface of one tool for scanning and tiering. */
export interface ScannableTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export function toScannableTool(tool: Tool): ScannableTool {
  const annotations = tool.annotations;
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(annotations !== undefined
      ? {
          annotations: {
            ...(typeof annotations.title === "string" ? { title: annotations.title } : {}),
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
            ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
            ...(typeof annotations.idempotentHint === "boolean" ? { idempotentHint: annotations.idempotentHint } : {}),
            ...(typeof annotations.openWorldHint === "boolean" ? { openWorldHint: annotations.openWorldHint } : {}),
          },
        }
      : {}),
  };
}

function scannableText(tool: ScannableTool): string {
  return [tool.name, tool.title ?? "", tool.description ?? "", JSON.stringify(tool.inputSchema ?? {})].join("\n");
}

/**
 * Scan one tool's live metadata against the poisoning pattern set.
 * Returns findings (possibly empty); deterministic for identical input.
 *
 * Tool *names* commonly join words with `_`/`-`, so each pattern is also
 * tested against a separator-normalized copy of the text.
 */
export function scanToolPoisoning(tool: ScannableTool): VetFinding[] {
  const text = scannableText(tool);
  const normalized = text.replace(/[_-]+/g, " ");
  const findings: VetFinding[] = [];
  for (const pattern of TOOL_POISON_PATTERNS) {
    if (pattern.pattern.test(text) || pattern.pattern.test(normalized)) {
      findings.push({
        severity: pattern.severity,
        code: `security/tool-poisoning/${pattern.id}`,
        tool: tool.name,
        message: `${pattern.message} (tool '${tool.name}')`,
        suggestion: pattern.suggestion,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Permission-risk tiering
// ---------------------------------------------------------------------------

export type ToolRiskTier = "read" | "write" | "network" | "exec" | "unknown";

export interface ToolRisk {
  name: string;
  tier: ToolRiskTier;
  reasons: string[];
}

export interface RiskProfile {
  total: number;
  byTier: Record<ToolRiskTier, number>;
  /** Most dangerous tier present: exec > network > write > read > unknown. */
  highestTier: ToolRiskTier;
  execTools: string[];
  networkTools: string[];
  writeTools: string[];
}

const EXEC_NAME_RE = /\b(exec(ute)?|spawn|shell|bash|sh\b|zsh|powershell|cmd(\.exe)?|terminal|eval(uate)?|system|popen|run_?command)\b/i;
const NETWORK_NAME_RE = /\b(fetch|https?|request|webhook|curl|wget|download|upload|browse|scrape|crawl|rest|graphql|socket|url)\b/i;
const WRITE_NAME_RE = /^(create|update|delete|remove|write|set|put|post|send|publish|deploy|insert|modify|edit|patch|move|rename|mkdir|touch|append|save|store|register|subscribe|grant|revoke)/i;
const READ_NAME_RE = /^(get|list|search|read|fetch|describe|show|query|find|check|inspect|view|lookup|retrieve|scan|status|ping|health)/i;
const EXEC_PROP_RE = /^(command|script|code|shell|executable|binary|interpreter)$/i;
const NETWORK_PROP_RE = /^(url|endpoint|uri|webhook|host|hostname)$/i;

function schemaPropertyNames(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const properties = schema["properties"];
  if (!isRecord(properties)) return [];
  return Object.keys(properties);
}

/**
 * Classify one tool's permission risk. MCP `annotations` are trusted first
 * (they are the server's own declaration), then name heuristics, then
 * inputSchema property shapes. `unknown` means "no signal either way" —
 * treat it as unaudited, not as safe.
 */
export function classifyToolRisk(tool: ScannableTool): ToolRisk {
  const reasons: string[] = [];
  const annotations = tool.annotations;

  if (annotations?.destructiveHint === true) reasons.push("annotations.destructiveHint=true");
  if (annotations?.openWorldHint === true) reasons.push("annotations.openWorldHint=true");
  if (annotations?.readOnlyHint === false) reasons.push("annotations.readOnlyHint=false");
  const declaredReadOnly = annotations?.readOnlyHint === true;
  if (declaredReadOnly) reasons.push("annotations.readOnlyHint=true");

  const name = tool.name;
  // Tool names join words with `_`/`-`; normalize so word-boundary patterns work.
  const normalizedName = name.toLowerCase().replace(/[_-]+/g, " ");
  const props = schemaPropertyNames(tool.inputSchema);

  if (EXEC_NAME_RE.test(normalizedName)) reasons.push(`name matches exec pattern`);
  if (props.some((p) => EXEC_PROP_RE.test(p))) reasons.push(`inputSchema has exec-shaped property (${props.filter((p) => EXEC_PROP_RE.test(p)).join(", ")})`);

  let tier: ToolRiskTier;
  if (reasons.some((r) => r.includes("destructiveHint")) || EXEC_NAME_RE.test(normalizedName) || props.some((p) => EXEC_PROP_RE.test(p))) {
    tier = "exec";
  } else if (
    annotations?.openWorldHint === true ||
    NETWORK_NAME_RE.test(normalizedName) ||
    props.some((p) => NETWORK_PROP_RE.test(p))
  ) {
    tier = "network";
    if (NETWORK_NAME_RE.test(normalizedName)) reasons.push("name matches network pattern");
    if (props.some((p) => NETWORK_PROP_RE.test(p))) reasons.push("inputSchema has URL-shaped property");
  } else if (
    annotations?.readOnlyHint === false ||
    WRITE_NAME_RE.test(normalizedName)
  ) {
    tier = "write";
    if (WRITE_NAME_RE.test(normalizedName)) reasons.push("name matches write pattern");
  } else if (declaredReadOnly || READ_NAME_RE.test(normalizedName)) {
    tier = "read";
    if (READ_NAME_RE.test(normalizedName) && !declaredReadOnly) reasons.push("name matches read pattern");
  } else {
    tier = "unknown";
    reasons.push("no read/write/network/exec signal in annotations, name, or schema");
  }
  return { name, tier, reasons };
}

/** Aggregate per-tool tiers into a server-level risk profile. */
export function summarizeRiskProfile(risks: ToolRisk[]): RiskProfile {
  const byTier: Record<ToolRiskTier, number> = { read: 0, write: 0, network: 0, exec: 0, unknown: 0 };
  const execTools: string[] = [];
  const networkTools: string[] = [];
  const writeTools: string[] = [];
  for (const risk of risks) {
    byTier[risk.tier] += 1;
    if (risk.tier === "exec") execTools.push(risk.name);
    else if (risk.tier === "network") networkTools.push(risk.name);
    else if (risk.tier === "write") writeTools.push(risk.name);
  }
  const order: ToolRiskTier[] = ["exec", "network", "write", "read", "unknown"];
  const highestTier = order.find((tier) => byTier[tier] > 0) ?? "unknown";
  return { total: risks.length, byTier, highestTier, execTools, networkTools, writeTools };
}

// ---------------------------------------------------------------------------
// Report & orchestration
// ---------------------------------------------------------------------------

export interface VetReport {
  target: { label: string; transport: VetTransportKind; transportDetail: string };
  probedAt: string;
  /** Set when the server could not be vetted at all (exit code 2). */
  protocolError: string | null;
  negotiatedVersion: string | null;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, unknown> | null;
  probes: ProtocolProbe[];
  /** `Mcp-Session-Id` issued on the vetted session (Streamable HTTP). */
  sessionId: string | null;
  /** Whether tools/list works with no session and no prior initialize (Streamable HTTP only). */
  statelessCapable: boolean | null;
  /** Server→client requests observed during the session. */
  observedServerRequests: ObservedServerRequest[];
  metaKeys: { initialize: string[]; toolsList: string[] };
  tools: ScannableTool[];
  risks: ToolRisk[];
  riskProfile: RiskProfile;
  findings: VetFinding[];
  /** True when there are no error findings and no protocol error. */
  ok: boolean;
}

export interface VetOptions {
  /** Protocol versions to offer, newest first. Defaults to KNOWN_PROTOCOL_VERSIONS. */
  versions?: string[];
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** How long to watch the vetted session for server→client requests. */
  observationWindowMs?: number;
}

function makeChannelFactory(target: VetTarget, transport: VetTransportKind): VetChannelFactory {
  if (target.kind === "stdio") {
    return async () => StdioVetChannel.spawn(target);
  }
  const headers = target.headers ?? {};
  if (transport === "sse") {
    return () => SseVetChannel.connect(target.url, headers);
  }
  return async () => new StreamableHttpVetChannel(target.url, headers);
}

function deprecationSuggestion(negotiated: string): string {
  return (
    `Server speaks ${negotiated} only — the 12-month deprecation window that opened with ` +
    `${CURRENT_SPEC_REVISION} is ticking. Ask the server maintainer for a ${CURRENT_SPEC_REVISION} ` +
    `build, or pin your client to the 2025 era deliberately instead of by accident.`
  );
}

/**
 * Vet a running server end to end. Never throws for server-side failures —
 * those become `protocolError` / findings; only programming errors reject.
 */
export async function vetServer(target: VetTarget, opts: VetOptions = {}): Promise<VetReport> {
  const versions = opts.versions ?? [...KNOWN_PROTOCOL_VERSIONS];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VET_TIMEOUT_MS;
  const observationWindowMs = opts.observationWindowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;

  const findings: VetFinding[] = [];
  let transport: VetTransportKind;
  let transportDetail: string;

  if (target.kind === "stdio") {
    transport = "stdio";
    transportDetail = `stdio: spawn \`${[target.command, ...(target.args ?? [])].join(" ")}\``;
  } else {
    const detected = await detectHttpTransport(target.url, target.headers ?? {}, timeoutMs);
    transport = detected.transport;
    transportDetail = detected.detail;
    if (transport === "unknown") {
      return failReport(target, transport, transportDetail, `No MCP transport detected at ${target.url}: ${transportDetail}`);
    }
  }

  const factory = makeChannelFactory(target, transport);

  // 1. Negotiation matrix: fresh channel per offered version.
  const probes: ProtocolProbe[] = [];
  for (const version of versions) {
    probes.push(await probeProtocolVersion(factory, version, timeoutMs));
  }
  const successful = probes.filter((p) => p.negotiated !== null);
  if (successful.length === 0) {
    const errors = probes.map((p) => `${p.offered}: ${p.error ?? "no negotiated version"}`).join("; ");
    return failReport(target, transport, transportDetail, `Server answered no initialize probe: ${errors}`);
  }

  // Newest negotiated version wins the deep session.
  const best = [...successful].sort((a, b) => versions.indexOf(a.negotiated as string) - versions.indexOf(b.negotiated as string))[0];
  if (!best) {
    return failReport(target, transport, transportDetail, "No successful negotiation probe (unreachable).");
  }
  const negotiatedVersion = best.negotiated as string;

  // 2. Era findings.
  const newestOffered = versions[0];
  if (negotiatedVersion !== newestOffered) {
    findings.push({
      severity: negotiatedVersion === "2025-06-18" || negotiatedVersion === "2025-11-25" ? "warning" : "info",
      code: "protocol/version-downgraded",
      message: `Offered ${newestOffered}, server negotiated ${negotiatedVersion}.`,
      suggestion: deprecationSuggestion(negotiatedVersion),
    });
  }
  if (transport === "sse") {
    findings.push({
      severity: "warning",
      code: "protocol/legacy-sse-transport",
      message: "Server uses the legacy SSE transport (2024-11-05 / 2025-03-26 era).",
      suggestion:
        "Migrate the server to Streamable HTTP. SSE is the legacy transport; new deployments should not offer it.",
    });
  }

  // 3. Deep session on the negotiated version.
  let channel: VetChannel;
  try {
    channel = await factory();
  } catch (error) {
    return failReport(
      target,
      transport,
      transportDetail,
      `Could not open a vetted session at negotiated ${negotiatedVersion}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let tools: ScannableTool[] = [];
  let statelessCapable: boolean | null = null;
  let sessionId: string | null = null;
  let toolsListMetaKeys: string[] = [];
  const observedServerRequests: ObservedServerRequest[] = [];
  try {
    const init = await channel.request("initialize", initializeParams(negotiatedVersion), { timeoutMs });
    if (init.error) {
      await channel.close().catch(() => undefined);
      return failReport(target, transport, transportDetail, `Re-initialize at negotiated ${negotiatedVersion} failed: ${init.error.message}`);
    }
    sessionId = init.responseHeaders?.["mcp-session-id"] ?? null;
    channel.notify("notifications/initialized", {});

    const list = await channel.request("tools/list", {}, { timeoutMs });
    if (list.error) {
      findings.push({
        severity: "warning",
        code: "protocol/tools-list-failed",
        message: `tools/list failed on the vetted session: ${list.error.message}`,
        suggestion: "The server negotiated initialize but refuses tools/list — check server logs; the tool surface can't be vetted.",
      });
    } else if (isRecord(list.result) && Array.isArray(list.result["tools"])) {
      const rawTools = list.result["tools"] as unknown[];
      tools = rawTools.filter(isRecord).map((t): ScannableTool => {
        const rec = t as Record<string, unknown>;
        const annotations = isRecord(rec["annotations"]) ? (rec["annotations"] as Record<string, unknown>) : undefined;
        return {
          name: typeof rec["name"] === "string" ? (rec["name"] as string) : "unknown",
          ...(typeof rec["title"] === "string" ? { title: rec["title"] as string } : {}),
          ...(typeof rec["description"] === "string" ? { description: rec["description"] as string } : {}),
          ...(rec["inputSchema"] !== undefined ? { inputSchema: rec["inputSchema"] } : {}),
          ...(annotations !== undefined
            ? {
                annotations: {
                  ...(typeof annotations["title"] === "string" ? { title: annotations["title"] as string } : {}),
                  ...(typeof annotations["readOnlyHint"] === "boolean" ? { readOnlyHint: annotations["readOnlyHint"] as boolean } : {}),
                  ...(typeof annotations["destructiveHint"] === "boolean" ? { destructiveHint: annotations["destructiveHint"] as boolean } : {}),
                  ...(typeof annotations["idempotentHint"] === "boolean" ? { idempotentHint: annotations["idempotentHint"] as boolean } : {}),
                  ...(typeof annotations["openWorldHint"] === "boolean" ? { openWorldHint: annotations["openWorldHint"] as boolean } : {}),
                },
              }
            : {}),
        };
      });
      toolsListMetaKeys = extractMetaKeys(list.result);
    }

    // 4. Watch for deprecated server→client primitives (sampling / roots).
    await new Promise((resolve) => setTimeout(resolve, observationWindowMs));
    observedServerRequests.push(...channel.observedServerRequests);
    for (const observed of observedServerRequests) {
      if (observed.method === "sampling/createMessage" || observed.method === "roots/list") {
        findings.push({
          severity: "warning",
          code: "protocol/deprecated-primitive-request",
          message: `Server sent ${observed.method} — a 2025-era server→client primitive.`,
          suggestion:
            "Under 2026-07-28, sampling and roots moved to the MRTR (multi-round-trip request) extension. " +
            "Ask the maintainer to migrate; clients on the new revision may not answer these requests.",
        });
      }
    }

    // 5. Mcp-Session-Id / stateless behavior (Streamable HTTP only).
    if (transport === "streamable-http" && target.kind === "http") {
      if (sessionId) {
        findings.push({
          severity: "info",
          code: "protocol/session-issued",
          message: "Server issued an Mcp-Session-Id (stateful session).",
          suggestion:
            "Stateful sessions are the 2025-era model. If the server also answers statelessly it is dual-era ready; otherwise clients must retain the session id.",
        });
      }
      // Stateless check: a fresh channel, no initialize, no session id —
      // straight to tools/list. A 2026-07-28-style stateless server answers;
      // a 2025-era stateful server rejects (missing/unknown session).
      const statelessProbe = new StreamableHttpVetChannel(target.url, target.headers ?? {});
      const statelessList = await statelessProbe.request("tools/list", {}, { timeoutMs });
      statelessCapable = !statelessList.error;
      if (statelessCapable) {
        findings.push({
          severity: "info",
          code: "protocol/stateless-capable",
          message: "Server answers tools/list with no session and no prior initialize — stateless (2026-07-28 style) operation works.",
          suggestion: "No action needed. Stateless-capable servers interoperate with both client eras.",
        });
      } else {
        findings.push({
          severity: "info",
          code: "protocol/session-required",
          message: "Server rejects tools/list without a session — stateful (2025-era) operation.",
          suggestion:
            "Clients must complete initialize and retain the Mcp-Session-Id. If dual-era support matters, ask the maintainer about a stateless mode.",
        });
      }
      await statelessProbe.close().catch(() => undefined);
    }
  } catch (error) {
    await channel.close().catch(() => undefined);
    return failReport(
      target,
      transport,
      transportDetail,
      `Vetted session at negotiated ${negotiatedVersion} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await channel.close().catch(() => undefined);
  }

  // 6. Security scan + risk tiering over the live tool list.
  for (const tool of tools) {
    findings.push(...scanToolPoisoning(tool));
  }
  const risks = tools.map(classifyToolRisk);
  const riskProfile = summarizeRiskProfile(risks);
  if (riskProfile.execTools.length > 0) {
    findings.push({
      severity: "warning",
      code: "risk/exec-tools-present",
      message: `${riskProfile.execTools.length} tool(s) can execute code: ${riskProfile.execTools.join(", ")}.`,
      suggestion:
        "Exec-capable tools are the highest-risk tier — a poisoned description here becomes remote code execution. " +
        "Sandbox the server process, review these tools first, and consider an allowlist.",
    });
  }
  if (riskProfile.networkTools.length > 0) {
    findings.push({
      severity: "info",
      code: "risk/network-tools-present",
      message: `${riskProfile.networkTools.length} tool(s) touch the network: ${riskProfile.networkTools.join(", ")}.`,
      suggestion:
        "Network-capable tools can exfiltrate data. Confirm each destination is expected and, where possible, egress-filter the server.",
    });
  }

  const ok = findings.every((f) => f.severity !== "error");
  return {
    target: { label: target.label, transport, transportDetail },
    probedAt: new Date().toISOString(),
    protocolError: null,
    negotiatedVersion,
    serverInfo: best.serverInfo,
    capabilities: best.capabilities,
    probes,
    sessionId,
    statelessCapable,
    observedServerRequests,
    metaKeys: { initialize: best.metaKeys, toolsList: toolsListMetaKeys },
    tools,
    risks,
    riskProfile,
    findings,
    ok,
  };
}

function failReport(
  target: VetTarget,
  transport: VetTransportKind,
  transportDetail: string,
  protocolError: string,
): VetReport {
  return {
    target: { label: target.label, transport, transportDetail },
    probedAt: new Date().toISOString(),
    protocolError,
    negotiatedVersion: null,
    serverInfo: null,
    capabilities: null,
    probes: [],
    sessionId: null,
    statelessCapable: null,
    observedServerRequests: [],
    metaKeys: { initialize: [], toolsList: [] },
    tools: [],
    risks: [],
    riskProfile: summarizeRiskProfile([]),
    findings: [
      {
        severity: "error",
        code: "protocol/unreachable",
        message: protocolError,
        suggestion:
          "Check that the server is running and reachable, that stdio commands don't need extra env vars, " +
          "and that HTTP servers don't require OAuth/mTLS — vetted servers must be probed live.",
      },
    ],
    ok: false,
  };
}

/**
 * Exit-code contract for `umt vet`:
 * - `0` — clean: negotiated fine, no error-severity findings (warnings/info ok).
 * - `1` — security findings: at least one error-severity finding.
 * - `2` — protocol error: the server couldn't be vetted at all.
 */
export function vetExitCode(report: VetReport): 0 | 1 | 2 {
  if (report.protocolError !== null) return 2;
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}
