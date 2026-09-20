import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getTracesDir,
  saveTrace,
  listTraces,
  loadTrace,
  resolveTraceModel,
  renderTraceTable,
  type SavedTraceSummary,
} from "../src/trace.js";
import type { ActiveTrace, Trace } from "@universal-mcp-toolkit/bridge";

function fakeTrace(): ActiveTrace {
  return {
    toJson: (t: Trace) => JSON.stringify(t, null, 2),
  } as unknown as ActiveTrace;
}

function sampleTrace(id: string): Trace {
  return {
    format: "umt-trace/1",
    id,
    startedAt: "2026-09-19T12:00:00.000Z",
    endedAt: "2026-09-19T12:00:01.000Z",
    model: "gpt-4o",
    spans: [
      {
        name: "github.search",
        server: "github",
        tool: "search",
        startTime: "2026-09-19T12:00:00.000Z",
        durationMs: 120,
        inputBytes: 20,
        outputBytes: 300,
        inputTokens: 6,
        outputTokens: 86,
        costUsd: 0.000875,
        status: "ok",
      },
    ],
    totals: {
      calls: 1,
      errors: 0,
      cachedHits: 0,
      durationMs: 120,
      inputBytes: 20,
      outputBytes: 300,
      inputTokens: 6,
      outputTokens: 86,
      costUsd: 0.000875,
    },
  };
}

describe("trace persistence (umt trace)", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "umt-trace-test-"));
    vi.stubEnv("HOME", homeDir);
    delete process.env.APPDATA;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("saves, lists, and loads traces", async () => {
    const trace = sampleTrace("trace-abc-123");
    const filePath = await saveTrace(fakeTrace(), trace);
    expect(filePath).toBe(path.join(getTracesDir(), "trace-abc-123.json"));

    const summaries = await listTraces();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: "trace-abc-123",
      calls: 1,
      errors: 0,
      costUsd: 0.000875,
    });

    const loaded = await loadTrace("trace-abc-123");
    expect(loaded).not.toBeNull();
    expect(JSON.parse(loaded!.json)).toMatchObject({ id: "trace-abc-123" });
  });

  it("supports prefix matching on trace IDs", async () => {
    await saveTrace(fakeTrace(), sampleTrace("trace-abc-123"));
    const loaded = await loadTrace("trace-abc");
    expect(loaded).not.toBeNull();
  });

  it("returns null for unknown trace IDs", async () => {
    await saveTrace(fakeTrace(), sampleTrace("trace-abc-123"));
    expect(await loadTrace("nope")).toBeNull();
  });

  it("returns an empty list when no traces exist", async () => {
    expect(await listTraces()).toEqual([]);
  });

  it("skips corrupt trace files", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(getTracesDir(), { recursive: true });
    await writeFile(path.join(getTracesDir(), "broken.json"), "not json", "utf8");
    await saveTrace(fakeTrace(), sampleTrace("good-trace"));
    const summaries = await listTraces();
    expect(summaries.map((s) => s.id)).toEqual(["good-trace"]);
  });
});

describe("resolveTraceModel", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the explicit CLI flag", () => {
    vi.stubEnv("UMT_TRACE_MODEL", "claude-sonnet-4");
    expect(resolveTraceModel("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("falls back to UMT_TRACE_MODEL, then the default", () => {
    vi.stubEnv("UMT_TRACE_MODEL", "claude-sonnet-4");
    expect(resolveTraceModel()).toBe("claude-sonnet-4");
    vi.stubEnv("UMT_TRACE_MODEL", "");
    expect(resolveTraceModel()).toBe("gpt-4o");
  });
});

describe("renderTraceTable", () => {
  it("renders a human-readable table of saved traces", () => {
    const summaries: SavedTraceSummary[] = [
      {
        id: "trace-abc-123",
        startedAt: "2026-09-19T12:00:00.000Z",
        endedAt: "2026-09-19T12:00:01.000Z",
        model: "gpt-4o",
        calls: 3,
        errors: 1,
        cachedHits: 1,
        durationMs: 450,
        costUsd: 0.0012,
      },
    ];
    const table = renderTraceTable(summaries);
    expect(table).toContain("ID");
    expect(table).toContain("trace-ab");
    expect(table).toContain("3");
    expect(table).toContain("$0.001200");
  });

  it("shows n/a when no cost estimate is available", () => {
    const summaries: SavedTraceSummary[] = [
      {
        id: "x",
        startedAt: "2026-09-19T12:00:00.000Z",
        endedAt: "2026-09-19T12:00:01.000Z",
        model: null,
        calls: 1,
        errors: 0,
        cachedHits: 0,
        durationMs: 10,
        costUsd: null,
      },
    ];
    expect(renderTraceTable(summaries)).toContain("n/a");
  });
});
