import { describe, expect, it } from "vitest";
import {
  buildMrtrResponses,
  formatDriftWarning,
  planMrtrPrompts,
} from "../src/task-cli.js";
import type { DefinitionDriftEvent } from "@universal-mcp-toolkit/bridge";

describe("planMrtrPrompts", () => {
  it("turns an elicitation/create request into one question per schema property", () => {
    const plans = planMrtrPrompts({
      "elicit-1": {
        method: "elicitation/create",
        params: {
          message: "Confirm the booking",
          requestedSchema: {
            type: "object",
            properties: {
              email: { type: "string", title: "Email address" },
              seats: { type: "integer", description: "Number of seats" },
              vip: { type: "boolean" },
            },
            required: ["email"],
          },
        },
      },
    });

    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.key).toBe("elicit-1");
    expect(plan.headline).toBe("Confirm the booking");
    expect(plan.rawJson).toBe(false);
    expect(plan.questions.map((q) => q.name)).toEqual(["email", "seats", "vip"]);
    expect(plan.questions[2]!.type).toBe("confirm");
    // Required text field gets a non-empty validator.
    expect(plan.questions[0]!.validate!("  ")).toBe("This field is required.");
    expect(plan.questions[0]!.validate!("a@b.c")).toBe(true);
    // Numeric field validates numbers.
    expect(plan.questions[1]!.validate!("3")).toBe(true);
    expect(plan.questions[1]!.validate!("abc")).toBe("Enter a number.");
  });

  it("falls back to a single value question for schema-less elicitation", () => {
    const plans = planMrtrPrompts({
      q: { method: "elicitation/create", params: { message: "Say something" } },
    });
    expect(plans[0]!.questions).toHaveLength(1);
    expect(plans[0]!.questions[0]!.name).toBe("value");
  });

  it("plans a raw-JSON prompt for non-elicitation methods", () => {
    const plans = planMrtrPrompts({
      "roots-1": { method: "roots/list", params: {} },
    });
    expect(plans[0]!.rawJson).toBe(true);
    expect(plans[0]!.questions[0]!.name).toBe("__raw");
    expect(plans[0]!.questions[0]!.validate!('{"a":1}')).toBe(true);
    expect(plans[0]!.questions[0]!.validate!("nope")).toBe("Enter valid JSON.");
  });
});

describe("buildMrtrResponses", () => {
  it("wraps elicitation answers as accept/content", () => {
    const plans = planMrtrPrompts({
      "elicit-1": {
        method: "elicitation/create",
        params: {
          message: "m",
          requestedSchema: { properties: { email: { type: "string" } } },
        },
      },
    });
    expect(
      buildMrtrResponses(plans, { "elicit-1": { email: "a@b.c" } }),
    ).toEqual({
      "elicit-1": { action: "accept", content: { email: "a@b.c" } },
    });
  });

  it("parses raw-JSON answers as-is", () => {
    const plans = planMrtrPrompts({ r: { method: "roots/list" } });
    expect(buildMrtrResponses(plans, { r: { __raw: '{"roots":[]}' } })).toEqual({
      r: { roots: [] },
    });
  });

  it("rejects invalid raw JSON", () => {
    const plans = planMrtrPrompts({ r: { method: "roots/list" } });
    expect(() => buildMrtrResponses(plans, { r: { __raw: "nope" } })).toThrow(
      /Invalid JSON response for input 'r'/,
    );
  });
});

describe("formatDriftWarning", () => {
  const event: DefinitionDriftEvent = {
    changed: true,
    previousDigest: "a".repeat(64),
    currentDigest: "b".repeat(64),
    added: ["exec"],
    removed: ["old_tool"],
    modified: ["read"],
    serverLabel: "stdio:mock",
    fetchedAt: "2026-09-19T00:00:00.000Z",
    cacheHint: {},
  };

  it("renders a loud warning naming the changed tools", () => {
    const text = formatDriftWarning(event);
    expect(text).toContain("DRIFT DETECTED");
    expect(text).toContain("stdio:mock");
    expect(text).toContain("+ added:    exec");
    expect(text).toContain("- removed:  old_tool");
    expect(text).toContain("~ modified: read");
    expect(text).toContain("supply-chain");
  });

  it("omits empty change sections", () => {
    const text = formatDriftWarning({ ...event, added: [], removed: [], modified: [] });
    expect(text).not.toContain("+ added");
    expect(text).not.toContain("- removed");
    expect(text).not.toContain("~ modified");
  });
});
