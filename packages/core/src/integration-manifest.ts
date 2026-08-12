import { z } from "zod";

export const UMT_INTEGRATION_SCHEMA_VERSION = "umt.dev/integration/v1" as const;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const INTEGRATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const uniqueStringArray = <T extends z.ZodType<string>>(itemSchema: T, duplicateMessage: string) =>
  z.array(itemSchema).refine(uniqueValues, duplicateMessage);

export const integrationMaturitySchema = z.enum(["stable", "beta", "experimental", "external"]);
export const integrationMaintainershipSchema = z.enum(["first-party", "community", "external"]);
export const integrationTransportSchema = z.enum(["stdio", "streamable-http", "sse"]);

export const integrationToolSchema = z
  .object({
    name: z.string().trim().min(1).max(128).regex(TOOL_NAME_PATTERN, "Tool names may contain letters, numbers, '.', '_', and '-'."),
    behavior: z
      .object({
        readOnly: z.boolean(),
        destructive: z.boolean(),
        idempotent: z.boolean(),
      })
      .strict(),
    inputSchemaRef: z.string().trim().min(1).optional(),
    outputSchemaRef: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((tool) => !(tool.behavior.readOnly && tool.behavior.destructive), {
    message: "A read-only tool cannot be destructive.",
    path: ["behavior", "destructive"],
  });

export const integrationConformanceSchema = z
  .object({
    contractTests: uniqueStringArray(z.string().trim().min(1), "Contract test references must be unique.").default([]),
    launchTest: z.string().trim().min(1).optional(),
    securityReview: z.string().trim().min(1).optional(),
    protocolRevisions: uniqueStringArray(z.string().trim().min(1), "Protocol revisions must be unique.").default([]),
  })
  .strict();

export const integrationManifestSchema = z
  .object({
    schemaVersion: z.literal(UMT_INTEGRATION_SCHEMA_VERSION),
    id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(INTEGRATION_ID_PATTERN, "Integration IDs must be lowercase kebab-case."),
    title: z.string().trim().min(1).max(200),
    version: z.string().regex(SEMVER_PATTERN, "Integration versions must be valid semantic versions."),
    maturity: integrationMaturitySchema,
    packageName: z.string().trim().min(1).max(214).regex(PACKAGE_NAME_PATTERN, "Package name must be a valid npm package name."),
    maintainership: integrationMaintainershipSchema,
    transports: uniqueStringArray(integrationTransportSchema, "Transports must be unique.").min(1),
    auth: z
      .object({
        envVars: uniqueStringArray(
          z.string().regex(ENV_VAR_PATTERN, "Environment variable names must use uppercase snake case."),
          "Authentication environment variables must be unique.",
        ).default([]),
        scopes: uniqueStringArray(z.string().trim().min(1), "Authentication scopes must be unique.").default([]),
      })
      .strict(),
    tools: z
      .array(integrationToolSchema)
      .refine((tools) => uniqueValues(tools.map((tool) => tool.name)), "Tool names must be unique."),
    conformance: integrationConformanceSchema,
  })
  .strict();

export type IntegrationMaturity = z.infer<typeof integrationMaturitySchema>;
export type IntegrationMaintainership = z.infer<typeof integrationMaintainershipSchema>;
export type IntegrationTransport = z.infer<typeof integrationTransportSchema>;
export type IntegrationTool = z.infer<typeof integrationToolSchema>;
export type IntegrationConformance = z.infer<typeof integrationConformanceSchema>;
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;

export type IntegrationReadinessRequirement =
  | "contractTests"
  | "launchTest"
  | "securityReview"
  | "protocolRevisions";

export interface IntegrationReadinessSummary {
  ready: boolean;
  completed: readonly IntegrationReadinessRequirement[];
  missing: readonly IntegrationReadinessRequirement[];
}

/** Validate unknown input and return a normalized integration manifest. */
export function validateIntegrationManifest(input: unknown): IntegrationManifest {
  return integrationManifestSchema.parse(input);
}

/** Summarize whether all required conformance evidence is present. */
export function summarizeIntegrationReadiness(manifest: IntegrationManifest): IntegrationReadinessSummary {
  const checks: Readonly<Record<IntegrationReadinessRequirement, boolean>> = {
    contractTests: manifest.conformance.contractTests.length > 0,
    launchTest: manifest.conformance.launchTest !== undefined,
    securityReview: manifest.conformance.securityReview !== undefined,
    protocolRevisions: manifest.conformance.protocolRevisions.length > 0,
  };
  const requirements = Object.keys(checks) as IntegrationReadinessRequirement[];
  const completed = requirements.filter((requirement) => checks[requirement]);
  const missing = requirements.filter((requirement) => !checks[requirement]);

  return {
    ready: missing.length === 0,
    completed,
    missing,
  };
}
