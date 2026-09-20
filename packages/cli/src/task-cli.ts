// Helpers for the 2026-07-28 CLI surfaces: MRTR input prompting and
// definition-drift warnings. Pure functions live here so they are unit
// testable; the interactive prompting itself stays in index.ts.

import chalk from "chalk";
import type {
  DefinitionDriftEvent,
  MCPFunctionCallingBridge,
  MrtrInputRequests,
  MrtrInputResponses,
} from "@universal-mcp-toolkit/bridge";

/** Minimal inquirer-compatible question shape (mirrors index.ts). */
export interface MrtrQuestion {
  type: string;
  name: string;
  message: string;
  choices?: Array<{ name: string; value: string }>;
  default?: unknown;
  validate?: (value: unknown) => true | string;
}

/**
 * One planned prompt round for a single MRTR input request.
 * `rawJson` plans ask for a pasted JSON blob (non-elicitation methods);
 * otherwise each question maps to one elicitation schema property.
 */
export interface MrtrPromptPlan {
  key: string;
  method: string;
  headline: string;
  questions: MrtrQuestion[];
  rawJson: boolean;
}

type JsonSchemaProp = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
};

/**
 * Turn MRTR `inputRequests` into CLI prompt plans.
 *
 * `elicitation/create` requests become one question per requested-schema
 * property (confirm for booleans, validated numeric input for numbers,
 * text otherwise). Anything else (sampling, roots, unknown methods) becomes
 * a single "paste JSON" prompt, since only the user knows the shape.
 */
export function planMrtrPrompts(requests: MrtrInputRequests): MrtrPromptPlan[] {
  return Object.entries(requests).map(([key, request]) => {
    const method = request.method ?? "unknown";
    const params = request.params ?? {};
    const message =
      typeof params.message === "string" && params.message.length > 0
        ? params.message
        : `The server requested input ('${key}' via ${method}).`;

    if (method === "elicitation/create") {
      const schema = (params.requestedSchema ?? {}) as {
        properties?: Record<string, JsonSchemaProp>;
        required?: string[];
      };
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const questions: MrtrQuestion[] = Object.entries(properties).map(
        ([propName, prop]) => {
          const label = prop.title ?? prop.description ?? propName;
          const base: MrtrQuestion = {
            type: "input",
            name: propName,
            message: `${label}${required.has(propName) ? " (required)" : ""}:`,
          };
          if (prop.default !== undefined) base.default = prop.default;
          if (prop.type === "boolean") {
            return {
              type: "confirm",
              name: propName,
              message: label,
              default: prop.default ?? false,
            } satisfies MrtrQuestion;
          }
          if (prop.type === "number" || prop.type === "integer") {
            base.validate = (value: unknown) => {
              if ((value === "" || value === undefined) && !required.has(propName)) {
                return true;
              }
              return Number.isFinite(Number(value)) || "Enter a number.";
            };
          } else if (required.has(propName)) {
            base.validate = (value: unknown) =>
              (typeof value === "string" && value.trim().length > 0) ||
              "This field is required.";
          }
          return base;
        },
      );
      // A schema-less elicitation still needs one free-text answer.
      if (questions.length === 0) {
        questions.push({
          type: "input",
          name: "value",
          message: `${message} (value):`,
        });
      }
      return { key, method, headline: message, questions, rawJson: false };
    }

    return {
      key,
      method,
      headline: `${message}\n${chalk.gray(
        "This input is not a form elicitation — paste the JSON response the server expects.",
      )}`,
      questions: [
        {
          type: "input",
          name: "__raw",
          message: `JSON response for '${key}':`,
          validate: (value: unknown) => {
            try {
              JSON.parse(value as string);
              return true;
            } catch {
              return "Enter valid JSON.";
            }
          },
        },
      ],
      rawJson: true,
    };
  });
}

/**
 * Build the `inputResponses` envelope from prompt answers.
 * Elicitation answers are wrapped as `{ action: "accept", content }`;
 * raw-JSON answers are parsed and sent as-is.
 */
export function buildMrtrResponses(
  plans: MrtrPromptPlan[],
  answersByKey: Record<string, Record<string, unknown>>,
): MrtrInputResponses {
  const responses: MrtrInputResponses = {};
  for (const plan of plans) {
    const answers = answersByKey[plan.key] ?? {};
    if (plan.rawJson) {
      const raw = answers.__raw;
      if (typeof raw !== "string") {
        throw new Error(`Missing JSON response for input '${plan.key}'.`);
      }
      try {
        responses[plan.key] = JSON.parse(raw);
      } catch {
        throw new Error(
          `Invalid JSON response for input '${plan.key}': ${raw.slice(0, 120)}`,
        );
      }
    } else {
      responses[plan.key] = { action: "accept", content: answers };
    }
  }
  return responses;
}

/**
 * Render a loud, unmissable warning for a definition-drift event.
 * A poisoned tools/list is the supply-chain attack vector — this must not
 * look like routine output.
 */
export function formatDriftWarning(event: DefinitionDriftEvent): string {
  const lines: string[] = [
    "",
    chalk.red.bold("⚠️  MCP TOOL DEFINITION DRIFT DETECTED"),
    chalk.red(`   Server: ${event.serverLabel}`),
    chalk.red(
      "   The server's tools/list no longer matches the pinned digest.",
    ),
    chalk.red(
      "   A poisoned tools/list is a supply-chain attack vector — verify this change is expected",
    ),
    chalk.red("   before trusting tool results from this server."),
    chalk.gray(
      `   digest ${event.previousDigest.slice(0, 12)}… → ${event.currentDigest.slice(0, 12)}… (${event.fetchedAt})`,
    ),
  ];
  if (event.added.length > 0) {
    lines.push(chalk.red(`   + added:    ${event.added.join(", ")}`));
  }
  if (event.removed.length > 0) {
    lines.push(chalk.red(`   - removed:  ${event.removed.join(", ")}`));
  }
  if (event.modified.length > 0) {
    lines.push(chalk.red(`   ~ modified: ${event.modified.join(", ")}`));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Attach a definition-drift listener to a bridge that prints the loud
 * warning to stderr (so `--json` stdout stays clean). Returns unsubscribe.
 */
export function watchDefinitionDrift(
  bridge: MCPFunctionCallingBridge,
  _serverId: string,
): () => void {
  return bridge.on("definition-drift", (event) => {
    console.error(formatDriftWarning(event));
  });
}
