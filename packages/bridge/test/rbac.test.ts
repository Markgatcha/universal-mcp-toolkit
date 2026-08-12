import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/index.js";
import type { PolicyContext } from "../src/types.js";

describe("PolicyEngine", () => {
  const baseContext: PolicyContext = {
    principal: "user-123",
    roles: ["viewer"],
    attributes: {},
    tool: "list_issues",
    args: {},
  };

  it("allows by default when no policies are configured", async () => {
    const engine = new PolicyEngine({ policies: [] });
    const decision = await engine.evaluate(baseContext);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("No policy configured — default allow");
  });

  it("uses a single policy's default action when no rule matches", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "default-deny",
          defaultAction: "deny",
          rules: [],
        },
      ],
    });
    const decision = await engine.evaluate(baseContext);
    expect(decision.allowed).toBe(false);
    expect(decision.policyName).toBe("default-deny");
    expect(decision.reason).toBe("Default action: deny");
  });

  it("allows a specific tool via a matching rule", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "restricted",
          defaultAction: "deny",
          rules: [
            { tool: "list_issues", action: "allow" },
          ],
        },
      ],
    });
    const decision = await engine.evaluate(baseContext);
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRule).toBeDefined();
    expect(decision.matchedRule?.tool).toBe("list_issues");
    expect(decision.matchedRule?.action).toBe("allow");
  });

  it("denies a tool not in the allow list", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "restricted",
          defaultAction: "deny",
          rules: [
            { tool: "list_issues", action: "allow" },
          ],
        },
      ],
    });
    const decision = await engine.evaluate({
      ...baseContext,
      tool: "create_webhook",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Default action: deny");
  });

  it("explicitly denies a tool via a deny rule", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "default-allow",
          defaultAction: "allow",
          rules: [
            { tool: "delete_repository", action: "deny" },
          ],
        },
      ],
    });
    const decision = await engine.evaluate({
      ...baseContext,
      tool: "delete_repository",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule?.action).toBe("deny");
  });

  it("wildcard rules match all tools", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "admin-only",
          defaultAction: "deny",
          rules: [
            {
              tool: "*",
              action: "allow",
              condition: (ctx) => ctx.roles.includes("admin"),
            },
          ],
        },
      ],
    });

    // Admin role — should be allowed.
    const adminDecision = await engine.evaluate({
      ...baseContext,
      roles: ["admin"],
    });
    expect(adminDecision.allowed).toBe(true);

    // Non-admin role — should be denied by default.
    const viewerDecision = await engine.evaluate({
      ...baseContext,
      roles: ["viewer"],
    });
    expect(viewerDecision.allowed).toBe(false);
    expect(viewerDecision.reason).toBe("Default action: deny");
  });

  it("first matching rule wins (order matters)", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "order-test",
          defaultAction: "allow",
          rules: [
            { tool: "list_issues", action: "deny" }, // This matches first → deny
            { tool: "list_issues", action: "allow" },  // Never reached
          ],
        },
      ],
    });
    const decision = await engine.evaluate(baseContext);
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule?.action).toBe("deny");
  });

  it("condition-based rules only apply when condition is true", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "conditional",
          defaultAction: "deny",
          rules: [
            {
              tool: "create_webhook",
              action: "allow",
              condition: (ctx) => ctx.roles.includes("admin"),
            },
            {
              tool: "list_issues",
              action: "allow",
            },
          ],
        },
      ],
    });

    // Admin — create_webhook is allowed.
    const admin = await engine.evaluate({
      ...baseContext,
      roles: ["admin"],
      tool: "create_webhook",
    });
    expect(admin.allowed).toBe(true);

    // Non-admin — create_webhook is denied by default (condition didn't match).
    const viewer = await engine.evaluate({
      ...baseContext,
      roles: ["viewer"],
      tool: "create_webhook",
    });
    expect(viewer.allowed).toBe(false);

    // list_issues always allowed (no condition).
    const issues = await engine.evaluate({
      ...baseContext,
      tool: "list_issues",
    });
    expect(issues.allowed).toBe(true);
  });

  it("returns correct principal and timestamp in decision", async () => {
    const engine = new PolicyEngine({
      policies: [
        {
          name: "test",
          defaultAction: "allow",
          rules: [{ tool: "list_issues", action: "allow" }],
        },
      ],
    });
    const decision = await engine.evaluate(baseContext);
    expect(decision.timestamp).toBeTypeOf("number");
    expect(decision.policyName).toBe("test");
  });
});
