import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  UMT_INTEGRATION_SCHEMA_VERSION,
  integrationManifestSchema,
  summarizeIntegrationReadiness,
  validateIntegrationManifest,
  type IntegrationManifest,
} from "../src/index.js";

function createManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: UMT_INTEGRATION_SCHEMA_VERSION,
    id: "github",
    title: "GitHub",
    version: "1.2.3",
    maturity: "stable",
    packageName: "@universal-mcp-toolkit/server-github",
    maintainership: "first-party",
    transports: ["stdio", "streamable-http"],
    auth: {
      envVars: ["GITHUB_TOKEN"],
      scopes: ["repo:read"],
    },
    tools: [
      {
        name: "get_repository",
        behavior: {
          readOnly: true,
          destructive: false,
          idempotent: true,
        },
        inputSchemaRef: "./schemas/get-repository.input.json",
        outputSchemaRef: "./schemas/get-repository.output.json",
      },
    ],
    conformance: {
      contractTests: ["./test/contract.test.ts"],
      launchTest: "https://ci.example.com/runs/launch-123",
      securityReview: "https://reviews.example.com/github-server-1.2.3",
      protocolRevisions: ["2025-06-18"],
    },
    ...overrides,
  };
}

describe("integrationManifestSchema", () => {
  it("validates and preserves a complete public integration manifest", () => {
    const manifest = validateIntegrationManifest(createManifest());

    expect(manifest).toMatchObject({
      schemaVersion: "umt.dev/integration/v1",
      id: "github",
      maturity: "stable",
      maintainership: "first-party",
      transports: ["stdio", "streamable-http"],
    });
    expect(manifest.tools[0]).toEqual({
      name: "get_repository",
      behavior: {
        readOnly: true,
        destructive: false,
        idempotent: true,
      },
      inputSchemaRef: "./schemas/get-repository.input.json",
      outputSchemaRef: "./schemas/get-repository.output.json",
    });
  });

  it("supports incremental adoption by defaulting collection evidence and auth lists", () => {
    const input = createManifest({
      auth: {},
      conformance: {},
    });
    const manifest = validateIntegrationManifest(input);

    expect(manifest.auth).toEqual({ envVars: [], scopes: [] });
    expect(manifest.conformance).toEqual({
      contractTests: [],
      protocolRevisions: [],
    });
    expect(summarizeIntegrationReadiness(manifest)).toEqual({
      ready: false,
      completed: [],
      missing: ["contractTests", "launchTest", "securityReview", "protocolRevisions"],
    });
  });

  it.each([
    ["schema version", { schemaVersion: "umt.dev/integration/v2" }],
    ["integration id", { id: "GitHub Server" }],
    ["semantic version", { version: "1.2" }],
    ["maturity", { maturity: "production" }],
    ["package name", { packageName: "@Invalid/Package" }],
    ["maintainership", { maintainership: "partner" }],
    ["transport", { transports: ["websocket"] }],
  ])("rejects an invalid %s", (_label, override) => {
    expect(() => validateIntegrationManifest(createManifest(override))).toThrow(ZodError);
  });

  it("rejects duplicate transports, auth values, tool names, and protocol revisions", () => {
    const duplicateCases = [
      createManifest({ transports: ["stdio", "stdio"] }),
      createManifest({ auth: { envVars: ["TOKEN", "TOKEN"], scopes: [] } }),
      createManifest({ auth: { envVars: [], scopes: ["read", "read"] } }),
      createManifest({
        tools: [
          { name: "duplicate", behavior: { readOnly: true, destructive: false, idempotent: true } },
          { name: "duplicate", behavior: { readOnly: false, destructive: true, idempotent: false } },
        ],
      }),
      createManifest({
        conformance: {
          contractTests: [],
          protocolRevisions: ["2025-06-18", "2025-06-18"],
        },
      }),
    ];

    for (const manifest of duplicateCases) {
      expect(integrationManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });

  it("rejects contradictory behavior annotations and malformed auth env vars", () => {
    const contradictoryTool = createManifest({
      tools: [
        {
          name: "unsafe_read",
          behavior: { readOnly: true, destructive: true, idempotent: false },
        },
      ],
    });
    const malformedEnvVar = createManifest({
      auth: { envVars: ["github-token"], scopes: [] },
    });

    expect(integrationManifestSchema.safeParse(contradictoryTool).success).toBe(false);
    expect(integrationManifestSchema.safeParse(malformedEnvVar).success).toBe(false);
  });

  it("rejects undeclared fields at every contract level", () => {
    const extraRootField = createManifest({ unexpected: true });
    const extraToolField = createManifest({
      tools: [
        {
          name: "get_repository",
          behavior: { readOnly: true, destructive: false, idempotent: true },
          description: "Not part of the v1 contract",
        },
      ],
    });

    expect(integrationManifestSchema.safeParse(extraRootField).success).toBe(false);
    expect(integrationManifestSchema.safeParse(extraToolField).success).toBe(false);
  });
});

describe("summarizeIntegrationReadiness", () => {
  it("reports a fully evidenced manifest as ready", () => {
    const manifest = validateIntegrationManifest(createManifest());

    expect(summarizeIntegrationReadiness(manifest)).toEqual({
      ready: true,
      completed: ["contractTests", "launchTest", "securityReview", "protocolRevisions"],
      missing: [],
    });
  });

  it("reports exactly which conformance evidence is missing", () => {
    const manifest = validateIntegrationManifest(
      createManifest({
        conformance: {
          contractTests: ["./test/contract.test.ts"],
          protocolRevisions: [],
        },
      }),
    ) as IntegrationManifest;

    expect(summarizeIntegrationReadiness(manifest)).toEqual({
      ready: false,
      completed: ["contractTests"],
      missing: ["launchTest", "securityReview", "protocolRevisions"],
    });
  });
});
