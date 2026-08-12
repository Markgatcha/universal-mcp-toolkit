import { describe, it, expect } from "vitest";
import { MCPFunctionCallingBridge } from "../src/bridge.js";

/**
 * Verify that the ToolAuditLogger is wired into MCPFunctionCallingBridge:
 * - auditLog option accepts a logger with a log() method
 * - auditLog: false disables auditing
 * - Audit entries are created with the correct structure
 * - Sensitive args are redacted
 */
describe("MCPFunctionCallingBridge audit logging", () => {
  it("accepts an auditLog logger without error", () => {
    const entries: unknown[] = [];

    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      {
        auditLog: {
          log: (entry) => entries.push(entry),
        },
      },
    );

    expect(bridge).toBeDefined();
  });

  it("auditLog: false does not error", () => {
    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      { auditLog: false },
    );

    expect(bridge).toBeDefined();
  });

  it("buildAuditEntry produces correctly structured entries", () => {
    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      { auditLog: { log: () => {} } },
    );

    // Access protected method via type cast.
    const bridgeAny = bridge as unknown as {
      buildAuditEntry: (
        toolName: string,
        args: Record<string, unknown>,
        success: boolean,
        error?: string,
        resultSizeChars?: number,
        durationMs?: number,
      ) => {
        timestamp: string;
        toolName: string;
        args: Record<string, unknown>;
        durationMs: number;
        success: boolean;
        error?: string;
        resultSizeChars?: number;
      };
    };

    // Test success entry.
    const successEntry = bridgeAny.buildAuditEntry(
      "github_list_issues",
      { owner: "user", repo: "my-repo", state: "open" },
      true,
      undefined,
      1024,
      150,
    );

    expect(successEntry.toolName).toBe("github_list_issues");
    expect(successEntry.success).toBe(true);
    expect(successEntry.durationMs).toBe(150);
    expect(successEntry.resultSizeChars).toBe(1024);
    expect(successEntry.error).toBeUndefined();
    expect(successEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(successEntry.args).toEqual({ owner: "user", repo: "my-repo", state: "open" });

    // Test error entry.
    const errorEntry = bridgeAny.buildAuditEntry(
      "github_create_issue",
      { title: "Bug", body: "Something broke" },
      false,
      "GraphQL error: Not found",
      0,
      50,
    );

    expect(errorEntry.toolName).toBe("github_create_issue");
    expect(errorEntry.success).toBe(false);
    expect(errorEntry.error).toBe("GraphQL error: Not found");
    expect(errorEntry.durationMs).toBe(50);
  });

  it("buildAuditEntry redacts sensitive argument keys", () => {
    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      { auditLog: { log: () => {} } },
    );

    const bridgeAny = bridge as unknown as {
      buildAuditEntry: (
        toolName: string,
        args: Record<string, unknown>,
        success: boolean,
        error?: string,
        resultSizeChars?: number,
        durationMs?: number,
      ) => { args: Record<string, unknown> };
    };

    const entry = bridgeAny.buildAuditEntry(
      "slack_post_message",
      {
        token: "xoxb-secret-token-123",
        api_key: "sk-secret-key",
        password: "hunter2",
        channel: "general",
        text: "Hello world",
        nested: {
          secret_credential: "nested-secret",
          query: "normal-value",
        },
      },
      true,
    );

    // Top-level sensitive keys should be redacted.
    expect(entry.args.token).toBe("[REDACTED]");
    expect(entry.args.api_key).toBe("[REDACTED]");
    expect(entry.args.password).toBe("[REDACTED]");

    // Non-sensitive keys should pass through.
    expect(entry.args.channel).toBe("general");
    expect(entry.args.text).toBe("Hello world");

    // Nested sensitive keys should also be redacted.
    const nested = entry.args.nested as Record<string, unknown>;
    expect(nested.secret_credential).toBe("[REDACTED]");
    expect(nested.query).toBe("normal-value");
  });
});
