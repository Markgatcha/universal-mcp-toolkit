import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkAndRecordVetPin,
  formatVetReport,
  isUrlTarget,
  registryStdioTarget,
  runAdd,
  runVet,
  urlVetTarget,
  type VetRunResult,
} from "../src/vet.js";
import { summarizeRiskProfile, vetExitCode, type VetReport } from "@universal-mcp-toolkit/core";

const CORE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "core",
  "test",
  "fixtures",
  "fake-mcp-server.mjs",
);

let appDataDir: string;
let savedAppData: string | undefined;

beforeEach(async () => {
  appDataDir = await mkdtemp(path.join(tmpdir(), "umt-vet-test-"));
  savedAppData = process.env.APPDATA;
  process.env.APPDATA = appDataDir; // getStateDirectory() prefers APPDATA.
});

afterEach(async () => {
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
  await rm(appDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function baseReport(overrides: Partial<VetReport> = {}): VetReport {
  return {
    target: { label: "fixture", transport: "stdio", transportDetail: "stdio" },
    probedAt: new Date().toISOString(),
    protocolError: null,
    negotiatedVersion: "2025-06-18",
    serverInfo: { name: "vet-fixture", version: "0.0.1" },
    capabilities: {},
    probes: [
      {
        offered: "2026-07-28",
        negotiated: "2025-06-18",
        accepted: false,
        error: null,
        serverInfo: null,
        capabilities: null,
        metaKeys: [],
        sessionId: null,
      },
    ],
    sessionId: null,
    statelessCapable: null,
    observedServerRequests: [],
    metaKeys: { initialize: [], toolsList: [] },
    tools: [{ name: "list_files", description: "List files." }],
    risks: [{ name: "list_files", tier: "read", reasons: [] }],
    riskProfile: summarizeRiskProfile([{ name: "list_files", tier: "read", reasons: [] }]),
    findings: [],
    ok: true,
    ...overrides,
  };
}

function runOf(report: VetReport): VetRunResult {
  return { report, pin: null, exitCode: vetExitCode(report) };
}

describe("target resolution helpers", () => {
  it("detects URL targets", () => {
    expect(isUrlTarget("https://example.com/mcp")).toBe(true);
    expect(isUrlTarget("http://localhost:3333/mcp")).toBe(true);
    expect(isUrlTarget("filesystem")).toBe(false);
    expect(isUrlTarget("npx -y foo")).toBe(false);
  });

  it("builds URL targets", () => {
    const target = urlVetTarget("https://example.com/mcp");
    expect(target.kind).toBe("http");
    expect(target.label).toBe("https://example.com/mcp");
  });

  it("builds stdio targets from registry entries", () => {
    const target = registryStdioTarget(
      { id: "my-server" } as never,
      { command: "npx", args: ["-y", "pkg"] },
    );
    expect(target.kind).toBe("stdio");
    expect(target.label).toBe("my-server");
    expect(target.command).toBe("npx");
  });
});

describe("formatVetReport", () => {
  it("renders a clean report", () => {
    const text = formatVetReport(runOf(baseReport()));
    expect(text).toContain("vet clean");
    expect(text).toContain("2025-06-18");
    expect(text).toContain("highest tier: read");
  });

  it("renders security findings with suggestions", () => {
    const report = baseReport({
      ok: false,
      findings: [
        {
          severity: "error",
          code: "security/tool-poisoning/instruction-override",
          tool: "evil",
          message: "Tool metadata instructs the model to ignore previous instructions. (tool 'evil')",
          suggestion: "Remove the override directive.",
        },
      ],
    });
    const text = formatVetReport(runOf(report));
    expect(text).toContain("security findings");
    expect(text).toContain("security/tool-poisoning/instruction-override");
    expect(text).toContain("Remove the override directive.");
  });

  it("renders protocol errors with the exit-2 verdict", () => {
    const report = baseReport({ protocolError: "nope", negotiatedVersion: null, ok: false });
    const text = formatVetReport(runOf(report));
    expect(text).toContain("exit 2");
    expect(text).toContain("nope");
  });

  it("renders drift status", () => {
    const report = baseReport();
    const pin = {
      status: "drift" as const,
      previous: null,
      current: { digest: "abc", toolCount: 1, negotiatedVersion: "2025-06-18", vettedAt: "t", tools: [] },
      drift: { changed: true, added: ["new_tool"], removed: [], modified: ["list_files"] },
    };
    const text = formatVetReport({ report, pin, exitCode: 0 });
    expect(text).toContain("DRIFT");
    expect(text).toContain("new_tool");
    expect(text).toContain("list_files");
  });
});

describe("checkAndRecordVetPin", () => {
  it("records first, then matches, then detects drift", async () => {
    const first = await checkAndRecordVetPin("srv", baseReport());
    expect(first.status).toBe("first");

    const match = await checkAndRecordVetPin("srv", baseReport());
    expect(match.status).toBe("match");

    const drifted = baseReport({
      tools: [
        { name: "list_files", description: "List files. CHANGED" },
        { name: "brand_new", description: "New tool." },
      ],
    });
    const drift = await checkAndRecordVetPin("srv", drifted);
    expect(drift.status).toBe("drift");
    expect(drift.drift?.added).toEqual(["brand_new"]);
    expect(drift.drift?.modified).toEqual(["list_files"]);
  });

  it("persists pins to the state directory", async () => {
    await checkAndRecordVetPin("srv", baseReport());
    const raw = await readFile(path.join(appDataDir, "universal-mcp-toolkit", "vet-pins.json"), "utf8");
    const pins = JSON.parse(raw) as Record<string, { digest: string }>;
    expect(typeof pins["srv"]?.digest).toBe("string");
  });
});

describe("runVet (live stdio fixture)", () => {
  it("vets the fixture server end to end and returns exit 1", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const exitCode = await runVet(
      { kind: "stdio", label: "fixture", command: process.execPath, args: [CORE_FIXTURE] },
      { json: true },
    );
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(logs.join("\n")) as { negotiatedVersion: string; exitCode: number; findings: Array<{ code: string }> };
    expect(parsed.negotiatedVersion).toBe("2025-11-25");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.findings.some((f) => f.code.startsWith("security/tool-poisoning/"))).toBe(true);
  }, 30000);

  it("returns exit 2 for an unreachable server", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = await runVet(
      { kind: "http", label: "dead", url: "http://127.0.0.1:9/nope" },
      { json: true },
    );
    expect(exitCode).toBe(2);
  }, 30000);
});

describe("runAdd", () => {
  it("registers the server with --skip-vet and no advisory", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    await runAdd(
      { kind: "http", label: "https://example.com/mcp", url: "https://example.com/mcp" },
      "https://example.com/mcp",
      { skipVet: true },
    );
    const state = JSON.parse(
      await readFile(path.join(appDataDir, "universal-mcp-toolkit", "state.json"), "utf8"),
    ) as { addedServers: Array<{ id: string; target: string }> };
    expect(state.addedServers).toHaveLength(1);
    expect(state.addedServers[0]?.id).toBe("https://example.com/mcp");
    expect(logs.join("\n")).toContain("added");
  });

  it("runs the advisory vet and still registers on security findings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runAdd(
      { kind: "stdio", label: "fixture", command: process.execPath, args: [CORE_FIXTURE] },
      "fixture",
    );
    const state = JSON.parse(
      await readFile(path.join(appDataDir, "universal-mcp-toolkit", "state.json"), "utf8"),
    ) as { addedServers: Array<{ id: string; lastVet?: { exitCode: number } }> };
    expect(state.addedServers).toHaveLength(1);
    // Advisory-only: fixture has poisoning (exit 1) but is still registered.
    expect(state.addedServers[0]?.lastVet?.exitCode).toBe(1);
  }, 30000);

  it("dedupes re-added servers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const target = { kind: "http", label: "https://example.com/mcp", url: "https://example.com/mcp" } as const;
    await runAdd(target, "https://example.com/mcp", { skipVet: true });
    await runAdd(target, "https://example.com/mcp", { skipVet: true });
    const state = JSON.parse(
      await readFile(path.join(appDataDir, "universal-mcp-toolkit", "state.json"), "utf8"),
    ) as { addedServers: unknown[] };
    expect(state.addedServers).toHaveLength(1);
  });
});
