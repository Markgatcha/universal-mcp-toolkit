export const WORKFLOW_VERSION = "umt.dev/workflow/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowStep {
  id: string;
  server: string;
  tool: string;
  args: Record<string, JsonValue>;
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_VERSION;
  name: string;
  inputs?: string[];
  steps: WorkflowStep[];
}

export interface WorkflowBridgeResult {
  output: string;
  error?: boolean;
}

export interface WorkflowBridge {
  connect(): Promise<void>;
  callTool(tool: string, args: Record<string, unknown>): Promise<WorkflowBridgeResult>;
  disconnect(): Promise<void>;
}

export interface WorkflowExecutionOptions {
  createBridge(serverId: string): WorkflowBridge | Promise<WorkflowBridge>;
}

export interface WorkflowRunResult {
  name: string;
  outputs: Record<string, string>;
}

export interface WorkflowReferenceContext {
  inputs: Readonly<Record<string, unknown>>;
  stepOutputs: Readonly<Record<string, unknown>>;
}

const INPUT_REFERENCE = /^\$inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/;
const STEP_REFERENCE = /^\$steps\.([A-Za-z_][A-Za-z0-9_-]*)\.output$/;
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid workflow:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export class WorkflowExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowExecutionError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): string[] {
  const allowedKeys = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => `${path} contains unsupported property '${key}'`);
}

function validateJsonValue(value: unknown, path: string, issues: string[]): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues));
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${path}.${key}`, issues);
    }
    return;
  }

  issues.push(`${path} must contain only JSON values`);
}

function visitStrings(value: unknown, path: string, visitor: (value: string, path: string) => void): void {
  if (typeof value === "string") {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, `${path}[${index}]`, visitor));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      visitStrings(item, `${path}.${key}`, visitor);
    }
  }
}

export function validateWorkflow(value: unknown): WorkflowDefinition {
  const issues: string[] = [];
  if (!isPlainObject(value)) {
    throw new WorkflowValidationError(["workflow must be a JSON object"]);
  }

  issues.push(...findUnexpectedKeys(value, ["version", "name", "inputs", "steps"], "workflow"));

  if (value.version !== WORKFLOW_VERSION) {
    issues.push(`version must be '${WORKFLOW_VERSION}'`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    issues.push("name must be a non-empty string");
  }

  const declaredInputs = new Set<string>();
  if (value.inputs !== undefined) {
    if (!Array.isArray(value.inputs)) {
      issues.push("inputs must be an array of input names");
    } else {
      value.inputs.forEach((input, index) => {
        if (typeof input !== "string" || !REFERENCE_NAME.test(input)) {
          issues.push(`inputs[${index}] must match ${REFERENCE_NAME}`);
        } else if (declaredInputs.has(input)) {
          issues.push(`inputs contains duplicate input '${input}'`);
        } else {
          declaredInputs.add(input);
        }
      });
    }
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    issues.push("steps must be an array containing at least one step");
  }

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const stepIndexes = new Map<string, number>();
  rawSteps.forEach((rawStep, index) => {
    const path = `steps[${index}]`;
    if (!isPlainObject(rawStep)) {
      issues.push(`${path} must be an object`);
      return;
    }

    issues.push(...findUnexpectedKeys(rawStep, ["id", "server", "tool", "args"], path));

    if (typeof rawStep.id !== "string" || !REFERENCE_NAME.test(rawStep.id)) {
      issues.push(`${path}.id must match ${REFERENCE_NAME}`);
    } else if (stepIndexes.has(rawStep.id)) {
      issues.push(`${path}.id duplicates step id '${rawStep.id}'`);
    } else {
      stepIndexes.set(rawStep.id, index);
    }
    if (typeof rawStep.server !== "string" || rawStep.server.trim().length === 0) {
      issues.push(`${path}.server must be a non-empty string`);
    }
    if (typeof rawStep.tool !== "string" || rawStep.tool.trim().length === 0) {
      issues.push(`${path}.tool must be a non-empty string`);
    }
    if (!isPlainObject(rawStep.args)) {
      issues.push(`${path}.args must be a JSON object`);
    } else {
      validateJsonValue(rawStep.args, `${path}.args`, issues);
    }
  });

  rawSteps.forEach((rawStep, index) => {
    if (!isPlainObject(rawStep) || !isPlainObject(rawStep.args)) return;

    visitStrings(rawStep.args, `steps[${index}].args`, (reference, path) => {
      const inputMatch = INPUT_REFERENCE.exec(reference);
      if (inputMatch) {
        const inputName = inputMatch[1] as string;
        if (!declaredInputs.has(inputName)) {
          issues.push(`${path} references unknown input '${inputName}'`);
        }
        return;
      }

      const stepMatch = STEP_REFERENCE.exec(reference);
      if (stepMatch) {
        const stepId = stepMatch[1] as string;
        const referencedIndex = stepIndexes.get(stepId);
        if (referencedIndex === undefined) {
          issues.push(`${path} references unknown step '${stepId}'`);
        } else if (referencedIndex >= index) {
          issues.push(`${path} references step '${stepId}' before it has run`);
        }
        return;
      }

      if (reference.startsWith("$inputs.") || reference.startsWith("$steps.")) {
        issues.push(`${path} contains malformed workflow reference '${reference}'`);
      }
    });
  });

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  return value as unknown as WorkflowDefinition;
}

export function parseWorkflowJson(source: string, sourceName = "workflow file"): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError([`${sourceName} is not valid JSON: ${detail}`]);
  }
  return validateWorkflow(parsed);
}

export function resolveWorkflowReferences(value: unknown, context: WorkflowReferenceContext): unknown {
  if (typeof value === "string") {
    const inputMatch = INPUT_REFERENCE.exec(value);
    if (inputMatch) {
      const inputName = inputMatch[1] as string;
      if (!Object.hasOwn(context.inputs, inputName)) {
        throw new WorkflowExecutionError(`Missing workflow input '${inputName}'.`);
      }
      return context.inputs[inputName];
    }

    const stepMatch = STEP_REFERENCE.exec(value);
    if (stepMatch) {
      const stepId = stepMatch[1] as string;
      if (!Object.hasOwn(context.stepOutputs, stepId)) {
        throw new WorkflowExecutionError(`Step output '${stepId}' is not available.`);
      }
      return context.stepOutputs[stepId];
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowReferences(item, context));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveWorkflowReferences(item, context)]),
    );
  }

  return value;
}

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  inputs: Readonly<Record<string, unknown>>,
  options: WorkflowExecutionOptions,
): Promise<WorkflowRunResult> {
  validateWorkflow(workflow);

  const declaredInputs = new Set(workflow.inputs ?? []);
  const unknownInputs = Object.keys(inputs).filter((name) => !declaredInputs.has(name));
  if (unknownInputs.length > 0) {
    throw new WorkflowExecutionError(`Unknown workflow input(s): ${unknownInputs.join(", ")}.`);
  }

  const outputs: Record<string, string> = {};
  const bridges = new Map<string, WorkflowBridge>();
  let executionError: unknown;

  try {
    for (const step of workflow.steps) {
      const args = resolveWorkflowReferences(step.args, { inputs, stepOutputs: outputs }) as Record<string, unknown>;

      try {
        let bridge = bridges.get(step.server);
        if (!bridge) {
          bridge = await options.createBridge(step.server);
          bridges.set(step.server, bridge);
          await bridge.connect();
        }

        const result = await bridge.callTool(step.tool, args);
        if (result.error) {
          throw new WorkflowExecutionError(
            `Step '${step.id}' (${step.server}:${step.tool}) failed: ${result.output}`,
          );
        }
        outputs[step.id] = result.output;
      } catch (error) {
        if (error instanceof WorkflowExecutionError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new WorkflowExecutionError(
          `Step '${step.id}' (${step.server}:${step.tool}) failed: ${detail}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
    }

    return { name: workflow.name, outputs };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    let disconnectError: unknown;
    for (const bridge of bridges.values()) {
      try {
        await bridge.disconnect();
      } catch (error) {
        disconnectError ??= error;
      }
    }

    if (executionError === undefined && disconnectError !== undefined) {
      const detail = disconnectError instanceof Error ? disconnectError.message : String(disconnectError);
      throw new WorkflowExecutionError(`Failed to disconnect workflow bridge: ${detail}`);
    }
  }
}
