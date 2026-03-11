import { pathToFileURL } from "node:url";

import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitPromptHandler,
  type ToolkitRuntimeRegistration,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

export const TEAM_RESOURCE_URI = "linear://team/default";
export const TOOL_NAMES = ["search_issues", "get_issue", "create_issue"] as const;
export const RESOURCE_NAMES = ["team"] as const;
export const PROMPT_NAMES = ["sprint-triage"] as const;

function preprocessOptionalTrimmedString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const requiredTrimmedStringSchema = z.string().trim().min(1);
const optionalTrimmedStringSchema = z.preprocess(preprocessOptionalTrimmedString, z.string().min(1).optional());
const optionalTeamKeySchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length === 0 ? undefined : normalized;
}, z.string().min(1).optional());
const optionalUrlSchema = z.preprocess(preprocessOptionalTrimmedString, z.string().url().optional());
const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");

const linearEnvShape = {
  LINEAR_API_KEY: requiredTrimmedStringSchema,
  LINEAR_DEFAULT_TEAM_ID: optionalTrimmedStringSchema,
  LINEAR_DEFAULT_TEAM_KEY: optionalTeamKeySchema,
  LINEAR_WORKSPACE_NAME: optionalTrimmedStringSchema,
  LINEAR_API_URL: optionalUrlSchema,
} satisfies z.ZodRawShape;

export interface LinearEnvironment {
  LINEAR_API_KEY: string;
  LINEAR_DEFAULT_TEAM_ID?: string;
  LINEAR_DEFAULT_TEAM_KEY?: string;
  LINEAR_WORKSPACE_NAME?: string;
  LINEAR_API_URL: string;
}

const teamShape = {
  id: z.string(),
  key: z.string(),
  name: z.string(),
} satisfies z.ZodRawShape;
const teamSchema = z.object(teamShape);
export type LinearTeam = z.infer<typeof teamSchema>;

const userShape = {
  id: z.string(),
  name: z.string(),
} satisfies z.ZodRawShape;
const userSchema = z.object(userShape);
export type LinearUser = z.infer<typeof userSchema>;

const issueStateShape = {
  name: z.string().nullable(),
  type: z.string().nullable(),
} satisfies z.ZodRawShape;
const issueStateSchema = z.object(issueStateShape);
export type LinearIssueState = z.infer<typeof issueStateSchema>;

const issueCycleShape = {
  id: z.string(),
  number: z.number().int().nullable(),
  name: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
} satisfies z.ZodRawShape;
const issueCycleSchema = z.object(issueCycleShape);
export type LinearIssueCycle = z.infer<typeof issueCycleSchema>;

const issueSummaryShape = {
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  priority: z.number().int().nullable(),
  state: issueStateSchema,
  team: teamSchema.nullable(),
  assignee: userSchema.nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
} satisfies z.ZodRawShape;
const issueSummarySchema = z.object(issueSummaryShape);
export type LinearIssueSummary = z.infer<typeof issueSummarySchema>;

const issueDetailShape = {
  ...issueSummaryShape,
  description: z.string().nullable(),
  branchName: z.string().nullable(),
  cycle: issueCycleSchema.nullable(),
} satisfies z.ZodRawShape;
const issueDetailSchema = z.object(issueDetailShape);
export type LinearIssueDetail = z.infer<typeof issueDetailSchema>;

export const searchIssuesInputShape = {
  query: requiredTrimmedStringSchema,
  limit: z.number().int().min(1).max(50).default(10),
  teamId: optionalTrimmedStringSchema,
  teamKey: optionalTeamKeySchema,
  stateName: optionalTrimmedStringSchema,
} satisfies z.ZodRawShape;
export type SearchIssuesToolInput = z.infer<z.ZodObject<typeof searchIssuesInputShape>>;

export const searchIssuesOutputShape = {
  query: z.string(),
  stateName: z.string().nullable(),
  team: teamSchema.nullable(),
  warning: z.string().nullable(),
  total: z.number().int().nonnegative(),
  issues: z.array(issueSummarySchema),
} satisfies z.ZodRawShape;
export type SearchIssuesToolOutput = z.infer<z.ZodObject<typeof searchIssuesOutputShape>>;

export const getIssueInputShape = {
  idOrIdentifier: requiredTrimmedStringSchema,
} satisfies z.ZodRawShape;
export type GetIssueToolInput = z.infer<z.ZodObject<typeof getIssueInputShape>>;

export const getIssueOutputShape = {
  issue: issueDetailSchema,
} satisfies z.ZodRawShape;
export type GetIssueToolOutput = z.infer<z.ZodObject<typeof getIssueOutputShape>>;

export const createIssueInputShape = {
  title: requiredTrimmedStringSchema,
  description: optionalTrimmedStringSchema,
  teamId: optionalTrimmedStringSchema,
  teamKey: optionalTeamKeySchema,
  priority: z.number().int().min(0).max(4).optional(),
  stateId: optionalTrimmedStringSchema,
  assigneeId: optionalTrimmedStringSchema,
  labelIds: z.array(requiredTrimmedStringSchema).max(25).optional(),
  dueDate: dueDateSchema.optional(),
  projectId: optionalTrimmedStringSchema,
  cycleId: optionalTrimmedStringSchema,
} satisfies z.ZodRawShape;
export type CreateIssueToolInput = z.infer<z.ZodObject<typeof createIssueInputShape>>;

export const createIssueOutputShape = {
  created: z.boolean(),
  issue: issueDetailSchema,
} satisfies z.ZodRawShape;
export type CreateIssueToolOutput = z.infer<z.ZodObject<typeof createIssueOutputShape>>;

export const sprintTriagePromptArgsShape = {
  teamId: optionalTrimmedStringSchema,
  teamKey: optionalTeamKeySchema,
  focus: optionalTrimmedStringSchema,
  objective: optionalTrimmedStringSchema,
  issueLimit: z.number().int().min(1).max(25).default(10),
  includeBacklog: z.boolean().default(true),
} satisfies z.ZodRawShape;
export type SprintTriagePromptArgs = z.infer<z.ZodObject<typeof sprintTriagePromptArgsShape>>;
type SprintTriagePromptResult = Awaited<ReturnType<ToolkitPromptHandler<typeof sprintTriagePromptArgsShape>>>;

export interface LinearTeamResourcePayload {
  workspaceName: string | null;
  configuredDefaultTeamId: string | null;
  configuredDefaultTeamKey: string | null;
  defaultTeam: LinearTeam | null;
  accessibleTeams: LinearTeam[];
  warning: string | null;
}

export interface LinearIssueSearchRequest {
  query: string;
  limit: number;
  teamId?: string;
  stateName?: string;
  issueNumber?: number;
}

export interface LinearCreateIssueInput {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
  stateId?: string;
  assigneeId?: string;
  labelIds?: string[];
  dueDate?: string;
  projectId?: string;
  cycleId?: string;
}

export interface LinearClient {
  listTeams(): Promise<LinearTeam[]>;
  searchIssues(input: LinearIssueSearchRequest): Promise<LinearIssueSummary[]>;
  getIssueById(id: string): Promise<LinearIssueDetail>;
  getIssueByIdentifier(teamId: string, issueNumber: number): Promise<LinearIssueDetail>;
  createIssue(input: LinearCreateIssueInput): Promise<LinearIssueDetail>;
}

const graphQlIssueStateSchema = z.object({
  name: z.string(),
  type: z.string().nullable().optional(),
});

const graphQlIssueCycleSchema = z.object({
  id: z.string(),
  number: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
});

const graphQlIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  state: graphQlIssueStateSchema.nullable().optional(),
  team: teamSchema.nullable().optional(),
  assignee: userSchema.nullable().optional(),
  cycle: graphQlIssueCycleSchema.nullable().optional(),
});
type GraphQlIssue = z.infer<typeof graphQlIssueSchema>;

const graphQlErrorSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
type LinearGraphQlError = z.infer<typeof graphQlErrorSchema>;

function createGraphQlEnvelopeSchema<TData>(dataSchema: z.ZodType<TData>) {
  return z.object({
    data: dataSchema.optional(),
    errors: z.array(graphQlErrorSchema).optional(),
  });
}

function normalizeTeamKey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length === 0 ? undefined : normalized;
}

function withOptionalProperty<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Partial<Record<TKey, TValue>> {
  return value === undefined ? {} : ({ [key]: value } as Record<TKey, TValue>);
}

function parseIssueIdentifier(value: string): { teamKey: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, rawTeamKey, rawIssueNumber] = match;
  if (rawTeamKey === undefined || rawIssueNumber === undefined) {
    return null;
  }

  const issueNumber = Number.parseInt(rawIssueNumber, 10);
  if (!Number.isSafeInteger(issueNumber)) {
    return null;
  }

  return {
    teamKey: rawTeamKey.toUpperCase(),
    number: issueNumber,
  };
}

function readUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function extractGraphQlErrorStatus(error: LinearGraphQlError): number | undefined {
  const extensions = error.extensions;
  if (!extensions) {
    return undefined;
  }

  const directStatus = readStatusCode(extensions.statusCode) ?? readStatusCode(extensions.status);
  if (directStatus !== undefined) {
    return directStatus;
  }

  const httpExtensions = readUnknownRecord(extensions.http);
  return httpExtensions ? readStatusCode(httpExtensions.status) : undefined;
}

function buildGraphQlError(
  operationName: string,
  errors: readonly LinearGraphQlError[],
  fallbackStatusCode = 502,
): ExternalServiceError {
  const statusCode =
    errors
      .map((error) => extractGraphQlErrorStatus(error))
      .find((value): value is number => value !== undefined) ?? fallbackStatusCode;

  return new ExternalServiceError(`Linear ${operationName} failed: ${errors.map((error) => error.message).join("; ")}`, {
    statusCode,
    details: errors,
  });
}

function normalizeIssue(issue: GraphQlIssue): LinearIssueDetail {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url ?? null,
    branchName: issue.branchName ?? null,
    priority: issue.priority ?? null,
    state: {
      name: issue.state?.name ?? null,
      type: issue.state?.type ?? null,
    },
    team: issue.team ?? null,
    assignee: issue.assignee ?? null,
    cycle: issue.cycle
      ? {
          id: issue.cycle.id,
          number: issue.cycle.number ?? null,
          name: issue.cycle.name ?? null,
          startsAt: issue.cycle.startsAt ?? null,
          endsAt: issue.cycle.endsAt ?? null,
        }
      : null,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
  };
}

function toIssueSummary(issue: LinearIssueDetail): LinearIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    priority: issue.priority,
    state: issue.state,
    team: issue.team,
    assignee: issue.assignee,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function renderIssueHeadline(issue: LinearIssueSummary | LinearIssueDetail): string {
  const parts = [`${issue.identifier}: ${issue.title}`];
  if (issue.state.name) {
    parts.push(`[${issue.state.name}]`);
  }
  if (issue.assignee) {
    parts.push(`@${issue.assignee.name}`);
  }
  return parts.join(" ");
}

function renderSearchIssuesOutput(output: SearchIssuesToolOutput): string {
  const headerParts = [`Found ${output.total} Linear issue${output.total === 1 ? "" : "s"} for "${output.query}"`];
  if (output.team) {
    headerParts.push(`in ${output.team.name} (${output.team.key})`);
  }
  if (output.stateName) {
    headerParts.push(`with state ${output.stateName}`);
  }

  const lines = [`${headerParts.join(" ")}.`];
  if (output.warning) {
    lines.push(`Warning: ${output.warning}`);
  }
  if (output.total === 0) {
    return lines.join("\n");
  }

  for (const issue of output.issues) {
    lines.push(`- ${renderIssueHeadline(issue)}`);
  }

  return lines.join("\n");
}

function renderGetIssueOutput(output: GetIssueToolOutput): string {
  const { issue } = output;
  const lines = [renderIssueHeadline(issue)];

  if (issue.team) {
    lines.push(`Team: ${issue.team.name} (${issue.team.key})`);
  }
  if (issue.url) {
    lines.push(`URL: ${issue.url}`);
  }
  if (issue.branchName) {
    lines.push(`Branch: ${issue.branchName}`);
  }
  if (issue.cycle?.name) {
    lines.push(`Cycle: ${issue.cycle.name}`);
  }
  if (issue.description) {
    lines.push("", issue.description);
  }

  return lines.join("\n");
}

function renderCreateIssueOutput(output: CreateIssueToolOutput): string {
  const { issue } = output;
  const lines = [`Created Linear issue ${issue.identifier}: ${issue.title}`];
  if (issue.team) {
    lines.push(`Team: ${issue.team.name} (${issue.team.key})`);
  }
  if (issue.url) {
    lines.push(`URL: ${issue.url}`);
  }
  return lines.join("\n");
}

const TEAM_FIELDS = `
  id
  key
  name
`;

const ISSUE_SUMMARY_FIELDS = `
  id
  identifier
  title
  url
  priority
  createdAt
  updatedAt
  state {
    name
    type
  }
  team {
    ${TEAM_FIELDS}
  }
  assignee {
    id
    name
  }
`;

const ISSUE_DETAIL_FIELDS = `
  ${ISSUE_SUMMARY_FIELDS}
  description
  branchName
  cycle {
    id
    number
    name
    startsAt
    endsAt
  }
`;

const LIST_TEAMS_QUERY = `
  query ListTeams($first: Int!) {
    teams(first: $first) {
      nodes {
        ${TEAM_FIELDS}
      }
    }
  }
`;

const SEARCH_ISSUES_QUERY = `
  query SearchIssues($filter: IssueFilter, $first: Int!) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        ${ISSUE_SUMMARY_FIELDS}
      }
    }
  }
`;

const GET_ISSUE_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      ${ISSUE_DETAIL_FIELDS}
    }
  }
`;

const FIND_ISSUE_BY_IDENTIFIER_QUERY = `
  query FindIssueByIdentifier($filter: IssueFilter, $first: Int!) {
    issues(filter: $filter, first: $first) {
      nodes {
        ${ISSUE_DETAIL_FIELDS}
      }
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        ${ISSUE_DETAIL_FIELDS}
      }
    }
  }
`;

const listTeamsResponseSchema = z.object({
  teams: z.object({
    nodes: z.array(teamSchema),
  }),
});

const searchIssuesResponseSchema = z.object({
  issues: z.object({
    nodes: z.array(graphQlIssueSchema),
  }),
});

const getIssueResponseSchema = z.object({
  issue: graphQlIssueSchema.nullable(),
});

const createIssueResponseSchema = z.object({
  issueCreate: z.object({
    success: z.boolean(),
    issue: graphQlIssueSchema.nullable(),
  }),
});

export interface LinearApiClientOptions {
  apiKey: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

export class LinearApiClient implements LinearClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchFn: typeof fetch;

  public constructor(options: LinearApiClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl ?? DEFAULT_LINEAR_API_URL;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async listTeams(): Promise<LinearTeam[]> {
    const response = await this.request("ListTeams", LIST_TEAMS_QUERY, { first: 100 }, listTeamsResponseSchema);
    return [...response.teams.nodes].sort((left, right) => left.key.localeCompare(right.key));
  }

  public async searchIssues(input: LinearIssueSearchRequest): Promise<LinearIssueSummary[]> {
    const filter: Record<string, unknown> = {};

    if (input.teamId) {
      filter.team = { id: { eq: input.teamId } };
    }
    if (input.stateName) {
      filter.state = { name: { eq: input.stateName } };
    }
    if (input.issueNumber !== undefined) {
      filter.number = { eq: input.issueNumber };
    } else {
      filter.title = { containsIgnoreCase: input.query };
    }

    const response = await this.request("SearchIssues", SEARCH_ISSUES_QUERY, { filter, first: input.limit }, searchIssuesResponseSchema);
    return response.issues.nodes.map((issue) => toIssueSummary(normalizeIssue(issue)));
  }

  public async getIssueById(id: string): Promise<LinearIssueDetail> {
    const response = await this.request("GetIssue", GET_ISSUE_QUERY, { id }, getIssueResponseSchema);
    if (!response.issue) {
      throw new ExternalServiceError(`Linear issue '${id}' was not found.`, {
        statusCode: 404,
        details: { id },
      });
    }

    return normalizeIssue(response.issue);
  }

  public async getIssueByIdentifier(teamId: string, issueNumber: number): Promise<LinearIssueDetail> {
    const filter = {
      team: { id: { eq: teamId } },
      number: { eq: issueNumber },
    };

    const response = await this.request(
      "FindIssueByIdentifier",
      FIND_ISSUE_BY_IDENTIFIER_QUERY,
      { filter, first: 1 },
      searchIssuesResponseSchema,
    );

    const issue = response.issues.nodes[0];
    if (!issue) {
      throw new ExternalServiceError(`Linear issue '${issueNumber}' was not found for team '${teamId}'.`, {
        statusCode: 404,
        details: { teamId, issueNumber },
      });
    }

    return normalizeIssue(issue);
  }

  public async createIssue(input: LinearCreateIssueInput): Promise<LinearIssueDetail> {
    const mutationInput: Record<string, unknown> = {
      title: input.title,
      teamId: input.teamId,
    };

    if (input.description !== undefined) {
      mutationInput.description = input.description;
    }
    if (input.priority !== undefined) {
      mutationInput.priority = input.priority;
    }
    if (input.stateId !== undefined) {
      mutationInput.stateId = input.stateId;
    }
    if (input.assigneeId !== undefined) {
      mutationInput.assigneeId = input.assigneeId;
    }
    if (input.labelIds !== undefined) {
      mutationInput.labelIds = input.labelIds;
    }
    if (input.dueDate !== undefined) {
      mutationInput.dueDate = input.dueDate;
    }
    if (input.projectId !== undefined) {
      mutationInput.projectId = input.projectId;
    }
    if (input.cycleId !== undefined) {
      mutationInput.cycleId = input.cycleId;
    }

    const response = await this.request("CreateIssue", CREATE_ISSUE_MUTATION, { input: mutationInput }, createIssueResponseSchema);
    if (!response.issueCreate.success || !response.issueCreate.issue) {
      throw new ExternalServiceError("Linear did not confirm that the issue was created.", {
        statusCode: 502,
        details: response.issueCreate,
      });
    }

    return normalizeIssue(response.issueCreate.issue);
  }

  private async request<TData>(
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    dataSchema: z.ZodType<TData>,
  ): Promise<TData> {
    let response: Response;

    try {
      response = await this.fetchFn(this.apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      const normalized = normalizeError(error);
      throw new ExternalServiceError(`Could not reach the Linear API while running ${operationName}.`, {
        statusCode: 502,
        details: {
          message: normalized.message,
          details: normalized.details,
        },
      });
    }

    const rawBody = await response.text();
    let payload: unknown = {};

    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        throw new ExternalServiceError(`Linear returned invalid JSON for ${operationName}.`, {
          statusCode: response.status || 502,
          details: rawBody.slice(0, 2_000),
        });
      }
    }

    const looseErrorEnvelope = createGraphQlEnvelopeSchema(z.unknown());
    const parsedLooseEnvelope = looseErrorEnvelope.safeParse(payload);

    if (!response.ok) {
      if (parsedLooseEnvelope.success && parsedLooseEnvelope.data.errors?.length) {
        throw buildGraphQlError(operationName, parsedLooseEnvelope.data.errors, response.status);
      }

      throw new ExternalServiceError(`Linear returned HTTP ${response.status} for ${operationName}.`, {
        statusCode: response.status,
        details: payload,
      });
    }

    const envelopeSchema = createGraphQlEnvelopeSchema(dataSchema);
    const parsedEnvelope = envelopeSchema.safeParse(payload);
    if (!parsedEnvelope.success) {
      throw new ExternalServiceError(`Linear returned an unexpected payload for ${operationName}.`, {
        details: parsedEnvelope.error.flatten(),
      });
    }

    if (parsedEnvelope.data.errors?.length) {
      throw buildGraphQlError(operationName, parsedEnvelope.data.errors);
    }

    if (parsedEnvelope.data.data === undefined) {
      throw new ExternalServiceError(`Linear returned no data for ${operationName}.`, {
        details: payload,
      });
    }

    return parsedEnvelope.data.data;
  }
}

export const metadata: ToolkitServerMetadata = {
  id: "linear",
  title: "Linear MCP Server",
  description: "Search, inspect, create, and triage Linear issues with team resources and prompts.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-linear",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://developers.linear.app/docs/graphql",
  envVarNames: [
    "LINEAR_API_KEY",
    "LINEAR_DEFAULT_TEAM_ID",
    "LINEAR_DEFAULT_TEAM_KEY",
    "LINEAR_WORKSPACE_NAME",
    "LINEAR_API_URL",
  ],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

interface TeamSelectionOptions {
  teamId?: string;
  teamKey?: string;
  useDefaults?: boolean;
  requireResolved?: boolean;
  strictOnMissing?: boolean;
}

interface TeamSelectionResult {
  teams: LinearTeam[];
  team: LinearTeam | null;
  warning: string | null;
}

export interface LinearServerOptions {
  client: LinearClient;
  defaultTeamId?: string | null;
  defaultTeamKey?: string | null;
  workspaceName?: string | null;
}

export class LinearServer extends ToolkitServer {
  private readonly client: LinearClient;
  private readonly defaultTeamId: string | null;
  private readonly defaultTeamKey: string | null;
  private readonly workspaceName: string | null;

  public constructor(options: LinearServerOptions) {
    super(metadata);

    this.client = options.client;
    this.defaultTeamId = options.defaultTeamId ?? null;
    this.defaultTeamKey = normalizeTeamKey(options.defaultTeamKey) ?? null;
    this.workspaceName = options.workspaceName ?? null;

    this.registerSearchIssuesTool();
    this.registerGetIssueTool();
    this.registerCreateIssueTool();
    this.registerTeamResource();
    this.registerSprintTriagePrompt();
  }

  public async getTeamResourcePayload(): Promise<LinearTeamResourcePayload> {
    return this.runOperation("load the Linear team resource", async () => {
      const selection = await this.resolveTeamSelection({
        useDefaults: true,
      });

      return {
        workspaceName: this.workspaceName,
        configuredDefaultTeamId: this.defaultTeamId,
        configuredDefaultTeamKey: this.defaultTeamKey,
        defaultTeam: selection.team,
        accessibleTeams: selection.teams,
        warning: selection.warning,
      };
    });
  }

  public async createSprintTriagePrompt(
    args: Partial<SprintTriagePromptArgs> = {},
  ): Promise<SprintTriagePromptResult> {
    return this.runOperation("create the sprint triage prompt", async () => {
      const selectionOptions: TeamSelectionOptions = {
        useDefaults: true,
        strictOnMissing: args.teamId !== undefined || args.teamKey !== undefined,
        ...withOptionalProperty("teamId", args.teamId),
        ...withOptionalProperty("teamKey", args.teamKey),
      };
      const selection = await this.resolveTeamSelection(selectionOptions);

      const issueLimit = args.issueLimit ?? 10;
      const includeBacklog = args.includeBacklog ?? true;
      const selectedTeamLabel = selection.team
        ? `${selection.team.name} (${selection.team.key})`
        : "No default team selected";
      const accessibleTeams =
        selection.teams.length > 0
          ? selection.teams.map((team) => `${team.name} (${team.key})`).join(", ")
          : "No teams were returned for this API token.";

      const text = [
        `You are preparing sprint triage for the Linear workspace ${this.workspaceName ?? "associated with the current API token"}.`,
        `Primary team context: ${selectedTeamLabel}.`,
        `Accessible teams: ${accessibleTeams}`,
        `Objective: ${args.objective ?? "Review the next sprint, identify the right scope, and flag any missing work."}`,
        `Focus area: ${args.focus ?? "overall sprint health, priorities, and blockers"}.`,
        `Review up to ${issueLimit} issues.`,
        includeBacklog
          ? "Include realistic backlog carry-over items if they are important for the next sprint."
          : "Exclude backlog carry-over items unless they are direct blockers for sprint goals.",
        "Use the available Linear capabilities in this order:",
        "1. Read the team resource at linear://team/default for team context.",
        "2. Use search_issues to gather candidate sprint work.",
        "3. Use get_issue for any issue that needs deeper inspection.",
        "4. Suggest create_issue actions for gaps, follow-up work, or missing dependencies.",
        "Return the triage plan grouped into: must ship, stretch, defer, blockers, and missing issues.",
        selection.warning ? `Warning: ${selection.warning}` : undefined,
        "Current team snapshot:",
        JSON.stringify(
          {
            workspaceName: this.workspaceName,
            selectedTeam: selection.team,
            accessibleTeams: selection.teams,
          },
          null,
          2,
        ),
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text,
            },
          },
        ],
      };
    });
  }

  private registerSearchIssuesTool(): void {
    this.registerTool(
      defineTool({
        name: "search_issues",
        title: "Search Linear issues",
        description: "Search Linear issues by title or exact issue identifier, optionally scoped to a team or state.",
        inputSchema: searchIssuesInputShape,
        outputSchema: searchIssuesOutputShape,
        handler: async (input, context) =>
          this.runOperation("search Linear issues", async () => {
            const identifier = parseIssueIdentifier(input.query);
            const requestedTeamKey = input.teamKey;

            if (identifier && requestedTeamKey && normalizeTeamKey(requestedTeamKey) !== identifier.teamKey) {
              throw new ValidationError(
                `The issue identifier '${input.query}' targets team '${identifier.teamKey}', which does not match teamKey '${requestedTeamKey}'.`,
              );
            }

            await context.log("info", `Searching Linear issues for '${input.query}'.`);

            const selectionOptions: TeamSelectionOptions = {
              useDefaults: input.teamId === undefined && requestedTeamKey === undefined && identifier === null,
              strictOnMissing: input.teamId !== undefined || requestedTeamKey !== undefined || identifier !== null,
              ...withOptionalProperty("teamId", input.teamId),
              ...withOptionalProperty("teamKey", requestedTeamKey ?? identifier?.teamKey),
            };
            const selection = await this.resolveTeamSelection(selectionOptions);

            const searchRequest: LinearIssueSearchRequest = {
              query: input.query,
              limit: input.limit,
              ...withOptionalProperty("stateName", input.stateName),
              ...withOptionalProperty("teamId", selection.team?.id),
              ...withOptionalProperty("issueNumber", identifier?.number),
            };
            const issues = await this.client.searchIssues(searchRequest);

            await context.log("info", `Linear returned ${issues.length} issue(s).`);

            return {
              query: input.query,
              stateName: input.stateName ?? null,
              team: selection.team,
              warning: selection.warning,
              total: issues.length,
              issues,
            };
          }),
        renderText: renderSearchIssuesOutput,
      }),
    );
  }

  private registerGetIssueTool(): void {
    this.registerTool(
      defineTool({
        name: "get_issue",
        title: "Get a Linear issue",
        description: "Get a Linear issue by UUID/id or by issue identifier such as ENG-123.",
        inputSchema: getIssueInputShape,
        outputSchema: getIssueOutputShape,
        handler: async (input, context) =>
          this.runOperation("get a Linear issue", async () => {
            await context.log("info", `Loading Linear issue '${input.idOrIdentifier}'.`);

            const parsedIdentifier = parseIssueIdentifier(input.idOrIdentifier);
            const issue =
              parsedIdentifier === null
                ? await this.client.getIssueById(input.idOrIdentifier)
                : await this.getIssueByTeamKeyAndNumber(parsedIdentifier.teamKey, parsedIdentifier.number);

            await context.log("info", `Loaded Linear issue '${issue.identifier}'.`);

            return { issue };
          }),
        renderText: renderGetIssueOutput,
      }),
    );
  }

  private registerCreateIssueTool(): void {
    this.registerTool(
      defineTool({
        name: "create_issue",
        title: "Create a Linear issue",
        description: "Create a new Linear issue using an explicit team or the configured default team.",
        inputSchema: createIssueInputShape,
        outputSchema: createIssueOutputShape,
        handler: async (input, context) =>
          this.runOperation("create a Linear issue", async () => {
            const selectionOptions: TeamSelectionOptions = {
              useDefaults: true,
              requireResolved: true,
              strictOnMissing: true,
              ...withOptionalProperty("teamId", input.teamId),
              ...withOptionalProperty("teamKey", input.teamKey),
            };
            const selection = await this.resolveTeamSelection(selectionOptions);

            if (!selection.team) {
              throw new ConfigurationError(
                "A Linear team is required to create issues. Provide teamId/teamKey or configure LINEAR_DEFAULT_TEAM_ID or LINEAR_DEFAULT_TEAM_KEY.",
              );
            }

            await context.log("info", `Creating a Linear issue in team '${selection.team.key}'.`);

            const createIssueInput: LinearCreateIssueInput = {
              teamId: selection.team.id,
              title: input.title,
              ...withOptionalProperty("description", input.description),
              ...withOptionalProperty("priority", input.priority),
              ...withOptionalProperty("stateId", input.stateId),
              ...withOptionalProperty("assigneeId", input.assigneeId),
              ...withOptionalProperty("labelIds", input.labelIds),
              ...withOptionalProperty("dueDate", input.dueDate),
              ...withOptionalProperty("projectId", input.projectId),
              ...withOptionalProperty("cycleId", input.cycleId),
            };
            const issue = await this.client.createIssue(createIssueInput);

            await context.log("info", `Created Linear issue '${issue.identifier}'.`);

            return {
              created: true,
              issue,
            };
          }),
        renderText: renderCreateIssueOutput,
      }),
    );
  }

  private registerTeamResource(): void {
    this.registerStaticResource(
      "team",
      TEAM_RESOURCE_URI,
      {
        title: "Linear team context",
        description: "JSON summary of accessible Linear teams and the configured default team.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.getTeamResourcePayload()),
    );
  }

  private registerSprintTriagePrompt(): void {
    this.registerPrompt(
      "sprint-triage",
      {
        title: "Sprint triage",
        description: "Create a sprint triage prompt grounded in the current Linear team context.",
        argsSchema: sprintTriagePromptArgsShape,
      },
      async (args) => this.createSprintTriagePrompt(args),
    );
  }

  private async getIssueByTeamKeyAndNumber(teamKey: string, issueNumber: number): Promise<LinearIssueDetail> {
    const selection = await this.resolveTeamSelection({
      teamKey,
      requireResolved: true,
      strictOnMissing: true,
    });

    if (!selection.team) {
      throw new ExternalServiceError(`Linear team '${teamKey}' was not found.`, {
        statusCode: 404,
        details: { teamKey },
      });
    }

    return this.client.getIssueByIdentifier(selection.team.id, issueNumber);
  }

  private async resolveTeamSelection(options: TeamSelectionOptions): Promise<TeamSelectionResult> {
    const teams = await this.client.listTeams();
    const requestedTeamId = options.teamId ?? (options.useDefaults ? this.defaultTeamId ?? undefined : undefined);
    const requestedTeamKey = normalizeTeamKey(options.teamKey) ?? (options.useDefaults ? this.defaultTeamKey ?? undefined : undefined);
    const usingDefaultSelection =
      options.useDefaults === true && options.teamId === undefined && options.teamKey === undefined;

    const byId = requestedTeamId ? teams.find((team) => team.id === requestedTeamId) ?? null : null;
    const byKey = requestedTeamKey
      ? teams.find((team) => normalizeTeamKey(team.key) === requestedTeamKey) ?? null
      : null;

    if (requestedTeamId && requestedTeamKey) {
      const mismatch = !byId || !byKey || byId.id !== byKey.id;
      if (mismatch) {
        if (usingDefaultSelection) {
          throw new ConfigurationError(
            "LINEAR_DEFAULT_TEAM_ID and LINEAR_DEFAULT_TEAM_KEY do not resolve to the same accessible Linear team.",
            {
              requestedTeamId,
              requestedTeamKey,
            },
          );
        }

        throw new ValidationError("teamId and teamKey must refer to the same Linear team.");
      }
    }

    const team = byId ?? byKey ?? null;
    if (team) {
      return {
        teams,
        team,
        warning: null,
      };
    }

    const requestedValue = requestedTeamId ?? requestedTeamKey;
    if (!requestedValue) {
      return {
        teams,
        team: null,
        warning: null,
      };
    }

    if (options.requireResolved || options.strictOnMissing) {
      throw new ExternalServiceError(`Linear team '${requestedValue}' was not found.`, {
        statusCode: 404,
        details: {
          requestedTeamId,
          requestedTeamKey,
        },
      });
    }

    return {
      teams,
      team: null,
      warning: usingDefaultSelection
        ? "The configured default Linear team could not be resolved with the current API token."
        : `Linear team '${requestedValue}' was not found.`,
    };
  }

  private async runOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof ValidationError) {
        throw error;
      }

      if (error instanceof ExternalServiceError) {
        throw new ExternalServiceError(`Unable to ${operation}. ${error.message}`, {
          statusCode: error.statusCode,
          details: error.details,
          exposeToClient: error.exposeToClient,
        });
      }

      const normalized = normalizeError(error);
      throw new ExternalServiceError(`Unable to ${operation}. ${normalized.message}`, {
        statusCode: normalized.statusCode,
        details: normalized.details,
        exposeToClient: normalized.exposeToClient,
      });
    }
  }
}

export interface CreateLinearServerOptions {
  client?: LinearClient;
  environment?: LinearEnvironment;
  fetchFn?: typeof fetch;
}

export function loadLinearEnvironment(source: NodeJS.ProcessEnv = process.env): LinearEnvironment {
  const env = loadEnv(linearEnvShape, source);
  const defaultTeamKey = normalizeTeamKey(env.LINEAR_DEFAULT_TEAM_KEY);

  return {
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    LINEAR_API_URL: env.LINEAR_API_URL ?? DEFAULT_LINEAR_API_URL,
    ...withOptionalProperty("LINEAR_DEFAULT_TEAM_ID", env.LINEAR_DEFAULT_TEAM_ID),
    ...withOptionalProperty("LINEAR_DEFAULT_TEAM_KEY", defaultTeamKey),
    ...withOptionalProperty("LINEAR_WORKSPACE_NAME", env.LINEAR_WORKSPACE_NAME),
  };
}

export async function createServer(options: CreateLinearServerOptions = {}): Promise<LinearServer> {
  const environment = options.environment ?? loadLinearEnvironment();
  const client =
    options.client ??
    new LinearApiClient({
      apiKey: environment.LINEAR_API_KEY,
      apiUrl: environment.LINEAR_API_URL,
      ...withOptionalProperty("fetchFn", options.fetchFn),
    });

  return new LinearServer({
    client,
    defaultTeamId: environment.LINEAR_DEFAULT_TEAM_ID ?? null,
    defaultTeamKey: environment.LINEAR_DEFAULT_TEAM_KEY ?? null,
    workspaceName: environment.LINEAR_WORKSPACE_NAME ?? null,
  });
}

const runtimeRegistration: ToolkitRuntimeRegistration = {
  createServer: () => createServer(),
  serverCard,
};

export async function main(): Promise<void> {
  const runtimeOptions = parseRuntimeOptions();
  await runToolkitServer(runtimeRegistration, runtimeOptions);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const normalized = normalizeError(error);
    console.error(normalized.toClientMessage());
    process.exitCode = 1;
  });
}
