import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
} from "@universal-mcp-toolkit/core";
import type {
  ToolkitRuntimeRegistration,
  ToolkitServerMetadata,
  ZodShape,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const PACKAGE_NAME = "@universal-mcp-toolkit/server-jira";
const SERVER_VERSION = "0.1.0";
const REQUIRED_ENV_VAR_NAMES = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
const OPTIONAL_ENV_VAR_NAMES = ["JIRA_DEFAULT_PROJECT_KEY"] as const;
const TOOL_NAMES = ["get_issue", "search_issues", "transition_issue"] as const;
const RESOURCE_NAMES = ["project"] as const;
const PROMPT_NAMES = ["incident_triage"] as const;
const DEFAULT_SEARCH_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "project",
  "created",
  "updated",
] as const;
const DEFAULT_ISSUE_FIELDS = [...DEFAULT_SEARCH_FIELDS, "description", "labels", "comment"] as const;

const jiraEnvironmentShape = {
  JIRA_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, "")),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().trim().min(1),
  JIRA_DEFAULT_PROJECT_KEY: z.string().trim().min(1).optional(),
} satisfies ZodShape;

const jiraUserSchema = z.object({
  accountId: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().nullable().optional(),
});

const jiraStatusSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  category: z.string().optional(),
});

const jiraPrioritySchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});

const jiraIssueTypeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  subtask: z.boolean().optional(),
});

const jiraProjectReferenceSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string(),
});

const jiraCommentSchema = z.object({
  id: z.string(),
  author: jiraUserSchema.optional(),
  body: z.string(),
  created: z.string().optional(),
  updated: z.string().optional(),
});

const jiraIssueSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  status: jiraStatusSchema.optional(),
  assignee: jiraUserSchema.optional(),
  reporter: jiraUserSchema.optional(),
  priority: jiraPrioritySchema.optional(),
  issueType: jiraIssueTypeSchema.optional(),
  project: jiraProjectReferenceSchema.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  url: z.string().url(),
});

const jiraIssueDetailSchema = jiraIssueSummarySchema.extend({
  description: z.string().optional(),
  labels: z.array(z.string()),
  comments: z.array(jiraCommentSchema),
});

const jiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  toStatus: jiraStatusSchema.optional(),
});

const jiraProjectSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  projectTypeKey: z.string().optional(),
  simplified: z.boolean().optional(),
  lead: jiraUserSchema.optional(),
  assigneeType: z.string().optional(),
  apiUrl: z.string().url().optional(),
});

const searchIssuesInputShape = {
  jql: z.string().trim().min(1).optional(),
  projectKey: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  status: z
    .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
    .optional(),
  assignee: z.string().trim().min(1).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  startAt: z.number().int().min(0).optional(),
  fields: z.array(z.string().trim().min(1)).min(1).max(50).optional(),
} satisfies ZodShape;

const searchIssuesOutputShape = {
  jql: z.string(),
  startAt: z.number().int().min(0),
  maxResults: z.number().int().min(1),
  total: z.number().int().min(0),
  issues: z.array(jiraIssueSummarySchema),
} satisfies ZodShape;

const getIssueInputShape = {
  issueKey: z.string().trim().min(1),
  fields: z.array(z.string().trim().min(1)).min(1).max(50).optional(),
} satisfies ZodShape;

const getIssueOutputShape = {
  issue: jiraIssueDetailSchema,
} satisfies ZodShape;

const transitionIssueInputShape = {
  issueKey: z.string().trim().min(1),
  transitionId: z.string().trim().min(1).optional(),
  transitionName: z.string().trim().min(1).optional(),
  comment: z.string().trim().min(1).max(5000).optional(),
} satisfies ZodShape;

const transitionIssueOutputShape = {
  issueKey: z.string(),
  transition: jiraTransitionSchema,
  commentAdded: z.boolean(),
  availableTransitions: z.array(jiraTransitionSchema),
  issue: jiraIssueDetailSchema,
} satisfies ZodShape;

const incidentTriagePromptArgsShape = {
  issueKey: z.string().trim().min(1).optional(),
  projectKey: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  symptoms: z.string().trim().min(1),
  impact: z.string().trim().min(1).optional(),
  suspectedService: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
} satisfies ZodShape;

const projectResourceParamsSchema = z.object({
  projectKey: z.string().trim().min(1),
});

const jiraUserResponseSchema = z
  .object({
    accountId: z.string().optional(),
    displayName: z.string().optional(),
    emailAddress: z.string().nullable().optional(),
  })
  .passthrough();

const jiraStatusResponseSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    statusCategory: z
      .object({
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const jiraPriorityResponseSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const jiraIssueTypeResponseSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  .passthrough();

const jiraProjectResponseSchema = z
  .object({
    id: z.string().optional(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    projectTypeKey: z.string().nullable().optional(),
    simplified: z.boolean().optional(),
    lead: jiraUserResponseSchema.nullish().optional(),
    assigneeType: z.string().nullable().optional(),
    self: z.string().url().optional(),
  })
  .passthrough();

const jiraCommentResponseSchema = z
  .object({
    id: z.string(),
    author: jiraUserResponseSchema.nullish().optional(),
    body: z.unknown().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

const jiraIssueFieldsResponseSchema = z
  .object({
    summary: z.string().nullable().optional(),
    description: z.unknown().optional(),
    status: jiraStatusResponseSchema.nullish().optional(),
    assignee: jiraUserResponseSchema.nullish().optional(),
    reporter: jiraUserResponseSchema.nullish().optional(),
    priority: jiraPriorityResponseSchema.nullish().optional(),
    issuetype: jiraIssueTypeResponseSchema.nullish().optional(),
    project: jiraProjectResponseSchema.nullish().optional(),
    labels: z.array(z.string()).optional(),
    comment: z
      .object({
        comments: z.array(jiraCommentResponseSchema),
      })
      .nullable()
      .optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

const jiraIssueResponseSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    fields: jiraIssueFieldsResponseSchema,
  })
  .passthrough();

const jiraSearchResponseSchema = z
  .object({
    startAt: z.number().int().min(0),
    maxResults: z.number().int().min(0),
    total: z.number().int().min(0),
    issues: z.array(jiraIssueResponseSchema),
  })
  .passthrough();

const jiraTransitionsResponseSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          to: jiraStatusResponseSchema.nullish().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const jiraErrorResponseSchema = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string(), z.string()).optional(),
    message: z.string().optional(),
  })
  .passthrough();

type SearchIssuesInput = z.infer<z.ZodObject<typeof searchIssuesInputShape>>;
type SearchIssuesOutput = z.infer<z.ZodObject<typeof searchIssuesOutputShape>>;
type GetIssueInput = z.infer<z.ZodObject<typeof getIssueInputShape>>;
type GetIssueOutput = z.infer<z.ZodObject<typeof getIssueOutputShape>>;
type TransitionIssueInput = z.infer<z.ZodObject<typeof transitionIssueInputShape>>;
type TransitionIssueOutput = z.infer<z.ZodObject<typeof transitionIssueOutputShape>>;
type IncidentTriagePromptArgs = z.infer<z.ZodObject<typeof incidentTriagePromptArgsShape>>;
type JiraIssueSummary = z.infer<typeof jiraIssueSummarySchema>;
type JiraIssueDetail = z.infer<typeof jiraIssueDetailSchema>;
type JiraTransition = z.infer<typeof jiraTransitionSchema>;
type JiraProject = z.infer<typeof jiraProjectSchema>;
type JiraUser = z.infer<typeof jiraUserSchema>;
type JiraStatus = z.infer<typeof jiraStatusSchema>;
type JiraPriority = z.infer<typeof jiraPrioritySchema>;
type JiraIssueType = z.infer<typeof jiraIssueTypeSchema>;
type JiraProjectReference = z.infer<typeof jiraProjectReferenceSchema>;
type JiraComment = z.infer<typeof jiraCommentSchema>;
type JiraIssueResponse = z.infer<typeof jiraIssueResponseSchema>;
type JiraProjectResponse = z.infer<typeof jiraProjectResponseSchema>;
type JiraTransitionResponse = z.infer<typeof jiraTransitionsResponseSchema>["transitions"][number];

export interface JiraEnvironment {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly defaultProjectKey?: string;
}

export interface JiraSearchRequest {
  readonly jql: string;
  readonly startAt: number;
  readonly maxResults: number;
  readonly fields: readonly string[];
}

export interface JiraSearchResult {
  readonly startAt: number;
  readonly maxResults: number;
  readonly total: number;
  readonly issues: readonly JiraIssueSummary[];
}

export interface JiraClient {
  searchIssues(request: JiraSearchRequest): Promise<JiraSearchResult>;
  getIssue(issueKey: string, fields?: readonly string[]): Promise<JiraIssueDetail>;
  getTransitions(issueKey: string): Promise<readonly JiraTransition[]>;
  transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void>;
  getProject(projectKey: string): Promise<JiraProject>;
}

interface JiraRequestOptions {
  readonly method: "GET" | "POST";
  readonly operation: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly badRequestMessage?: string;
  readonly notFoundMessage?: string;
}

export interface JiraRestClientOptions {
  readonly environment: JiraEnvironment;
  readonly fetchImpl?: typeof fetch;
}

export interface JiraServerOptions {
  readonly client?: JiraClient;
  readonly environment?: JiraEnvironment;
  readonly envSource?: NodeJS.ProcessEnv;
}

function createBasicAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
}

function appendErrorDetail(message: string, detail?: string): string {
  const trimmedDetail = detail?.trim();
  if (!trimmedDetail) {
    return message;
  }

  return `${message} ${trimmedDetail}`;
}

function escapeJqlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quoteJqlValue(value: string): string {
  return `"${escapeJqlValue(value)}"`;
}

function formatStatusClause(status: string | string[]): string {
  if (typeof status === "string") {
    return `status = ${quoteJqlValue(status)}`;
  }

  return `status in (${status.map((value) => quoteJqlValue(value)).join(", ")})`;
}

function createIssueBrowseUrl(baseUrl: string, issueKey: string): string {
  return new URL(`browse/${encodeURIComponent(issueKey)}`, `${baseUrl}/`).toString();
}

function createProjectResourceUri(projectKey: string): string {
  return `jira://projects/${encodeURIComponent(projectKey)}`;
}

function createJiraDocument(text: string): {
  type: "doc";
  version: 1;
  content: Array<{
    type: "paragraph";
    content: Array<{
      type: "text";
      text: string;
    }>;
  }>;
} {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
          },
        ],
      },
    ],
  };
}

function collectDocumentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => collectDocumentText(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const nodeType = typeof record.type === "string" ? record.type : undefined;
  const directText = typeof record.text === "string" ? record.text : "";
  const contentText = Array.isArray(record.content)
    ? record.content.map((entry) => collectDocumentText(entry)).join("")
    : "";
  const combinedText = `${directText}${contentText}`;

  switch (nodeType) {
    case "bulletList":
    case "heading":
    case "listItem":
    case "orderedList":
    case "paragraph":
      return `${combinedText}\n`;
    case "hardBreak":
      return "\n";
    default:
      return combinedText;
  }
}

function extractText(value: unknown): string | undefined {
  const text = collectDocumentText(value).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 0 ? text : undefined;
}

function formatJiraApiError(body: unknown, fallbackText: string): string | undefined {
  const parsed = jiraErrorResponseSchema.safeParse(body);
  const messages: string[] = [];

  if (parsed.success) {
    if (parsed.data.message?.trim()) {
      messages.push(parsed.data.message.trim());
    }

    for (const message of parsed.data.errorMessages ?? []) {
      if (message.trim()) {
        messages.push(message.trim());
      }
    }

    if (parsed.data.errors) {
      for (const [field, message] of Object.entries(parsed.data.errors)) {
        const trimmedMessage = message.trim();
        if (trimmedMessage) {
          messages.push(`${field}: ${trimmedMessage}`);
        }
      }
    }
  }

  const trimmedFallback = fallbackText.trim();
  if (messages.length > 0) {
    return messages.join("; ");
  }

  return trimmedFallback.length > 0 ? trimmedFallback : undefined;
}

function normalizeUser(user: z.infer<typeof jiraUserResponseSchema> | null | undefined): JiraUser | undefined {
  if (!user) {
    return undefined;
  }

  const displayName = user.displayName?.trim() || user.emailAddress?.trim() || user.accountId?.trim();
  if (!displayName) {
    return undefined;
  }

  const normalized: JiraUser = {
    displayName,
  };

  if (user.accountId?.trim()) {
    normalized.accountId = user.accountId.trim();
  }

  if (user.emailAddress !== undefined) {
    normalized.emailAddress = user.emailAddress;
  }

  return normalized;
}

function normalizeStatus(status: z.infer<typeof jiraStatusResponseSchema> | null | undefined): JiraStatus | undefined {
  if (!status?.name?.trim()) {
    return undefined;
  }

  const normalized: JiraStatus = {
    name: status.name.trim(),
  };

  if (status.id?.trim()) {
    normalized.id = status.id.trim();
  }

  if (status.statusCategory?.name?.trim()) {
    normalized.category = status.statusCategory.name.trim();
  }

  return normalized;
}

function normalizePriority(priority: z.infer<typeof jiraPriorityResponseSchema> | null | undefined): JiraPriority | undefined {
  if (!priority?.name?.trim()) {
    return undefined;
  }

  const normalized: JiraPriority = {
    name: priority.name.trim(),
  };

  if (priority.id?.trim()) {
    normalized.id = priority.id.trim();
  }

  return normalized;
}

function normalizeIssueType(
  issueType: z.infer<typeof jiraIssueTypeResponseSchema> | null | undefined,
): JiraIssueType | undefined {
  if (!issueType?.name?.trim()) {
    return undefined;
  }

  const normalized: JiraIssueType = {
    name: issueType.name.trim(),
  };

  if (issueType.id?.trim()) {
    normalized.id = issueType.id.trim();
  }

  if (issueType.subtask !== undefined) {
    normalized.subtask = issueType.subtask;
  }

  return normalized;
}

function normalizeProjectReference(project: JiraProjectResponse | null | undefined): JiraProjectReference | undefined {
  if (!project) {
    return undefined;
  }

  const normalized: JiraProjectReference = {
    key: project.key,
    name: project.name,
  };

  if (project.id?.trim()) {
    normalized.id = project.id.trim();
  }

  return normalized;
}

function normalizeComment(comment: z.infer<typeof jiraCommentResponseSchema>): JiraComment {
  const normalized: JiraComment = {
    id: comment.id,
    body: extractText(comment.body) ?? "",
  };

  const author = normalizeUser(comment.author);
  if (author) {
    normalized.author = author;
  }

  if (comment.created?.trim()) {
    normalized.created = comment.created.trim();
  }

  if (comment.updated?.trim()) {
    normalized.updated = comment.updated.trim();
  }

  return normalized;
}

function normalizeIssueSummary(issue: JiraIssueResponse, baseUrl: string): JiraIssueSummary {
  const normalized: JiraIssueSummary = {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary?.trim() || issue.key,
    url: createIssueBrowseUrl(baseUrl, issue.key),
  };

  const status = normalizeStatus(issue.fields.status);
  if (status) {
    normalized.status = status;
  }

  const assignee = normalizeUser(issue.fields.assignee);
  if (assignee) {
    normalized.assignee = assignee;
  }

  const reporter = normalizeUser(issue.fields.reporter);
  if (reporter) {
    normalized.reporter = reporter;
  }

  const priority = normalizePriority(issue.fields.priority);
  if (priority) {
    normalized.priority = priority;
  }

  const issueType = normalizeIssueType(issue.fields.issuetype);
  if (issueType) {
    normalized.issueType = issueType;
  }

  const project = normalizeProjectReference(issue.fields.project);
  if (project) {
    normalized.project = project;
  }

  if (issue.fields.created?.trim()) {
    normalized.created = issue.fields.created.trim();
  }

  if (issue.fields.updated?.trim()) {
    normalized.updated = issue.fields.updated.trim();
  }

  return normalized;
}

function normalizeIssueDetail(issue: JiraIssueResponse, baseUrl: string): JiraIssueDetail {
  const normalized: JiraIssueDetail = {
    ...normalizeIssueSummary(issue, baseUrl),
    labels: issue.fields.labels ?? [],
    comments: (issue.fields.comment?.comments ?? []).map((comment) => normalizeComment(comment)),
  };

  const description = extractText(issue.fields.description);
  if (description) {
    normalized.description = description;
  }

  return normalized;
}

function normalizeTransition(transition: JiraTransitionResponse): JiraTransition {
  const normalized: JiraTransition = {
    id: transition.id,
    name: transition.name,
  };

  const toStatus = normalizeStatus(transition.to);
  if (toStatus) {
    normalized.toStatus = toStatus;
  }

  return normalized;
}

function normalizeProject(project: JiraProjectResponse): JiraProject {
  const normalized: JiraProject = {
    key: project.key,
    name: project.name,
  };

  if (project.id?.trim()) {
    normalized.id = project.id.trim();
  }

  if (project.description?.trim()) {
    normalized.description = project.description.trim();
  }

  if (project.projectTypeKey?.trim()) {
    normalized.projectTypeKey = project.projectTypeKey.trim();
  }

  if (project.simplified !== undefined) {
    normalized.simplified = project.simplified;
  }

  const lead = normalizeUser(project.lead);
  if (lead) {
    normalized.lead = lead;
  }

  if (project.assigneeType?.trim()) {
    normalized.assigneeType = project.assigneeType.trim();
  }

  if (project.self?.trim()) {
    normalized.apiUrl = project.self.trim();
  }

  return normalized;
}

function buildSearchJql(input: SearchIssuesInput, defaultProjectKey?: string): string {
  const structuredClauses: string[] = [];

  const effectiveProjectKey = input.jql ? input.projectKey : (input.projectKey ?? defaultProjectKey);
  if (effectiveProjectKey) {
    structuredClauses.push(`project = ${quoteJqlValue(effectiveProjectKey)}`);
  }

  if (input.status) {
    structuredClauses.push(formatStatusClause(input.status));
  }

  if (input.assignee) {
    structuredClauses.push(`assignee = ${quoteJqlValue(input.assignee)}`);
  }

  if (input.text) {
    structuredClauses.push(`text ~ ${quoteJqlValue(input.text)}`);
  }

  const hasOrderByInJql = input.jql ? /\border\s+by\b/i.test(input.jql) : false;
  if (input.jql && hasOrderByInJql && structuredClauses.length > 0) {
    throw new ValidationError(
      "Do not combine structured search filters with a JQL query that already contains ORDER BY.",
    );
  }

  let jql = input.jql?.trim() ?? "";
  if (jql && structuredClauses.length > 0) {
    jql = `(${jql}) AND ${structuredClauses.join(" AND ")}`;
  } else if (!jql) {
    jql = structuredClauses.join(" AND ");
  }

  if (!jql) {
    throw new ValidationError(
      `Provide JQL or at least one search filter, or configure ${OPTIONAL_ENV_VAR_NAMES[0]} for a default project.`,
    );
  }

  if (!/\border\s+by\b/i.test(jql)) {
    jql = `${jql} ORDER BY updated DESC`;
  }

  return jql;
}

function createSearchRequest(input: SearchIssuesInput, environment: JiraEnvironment): JiraSearchRequest {
  const fields = input.fields ?? DEFAULT_SEARCH_FIELDS;
  return {
    jql: buildSearchJql(input, environment.defaultProjectKey),
    startAt: input.startAt ?? 0,
    maxResults: input.maxResults ?? 10,
    fields,
  };
}

function renderSearchIssues(output: SearchIssuesOutput): string {
  const header = `Found ${output.issues.length} of ${output.total} Jira issues.`;
  const jql = `JQL: ${output.jql}`;
  const issues = output.issues.map((issue) => {
    const status = issue.status?.name ?? "Unknown";
    return `- ${issue.key}: ${issue.summary} (${status})`;
  });

  return [header, jql, ...issues].join("\n");
}

function renderIssueDetail(output: GetIssueOutput): string {
  const { issue } = output;
  const lines = [
    `${issue.key}: ${issue.summary}`,
    `Status: ${issue.status?.name ?? "Unknown"}`,
    `Assignee: ${issue.assignee?.displayName ?? "Unassigned"}`,
    `Reporter: ${issue.reporter?.displayName ?? "Unknown"}`,
    `Priority: ${issue.priority?.name ?? "Unknown"}`,
    `Project: ${issue.project?.key ?? "Unknown"}`,
  ];

  if (issue.description) {
    lines.push("", issue.description);
  }

  return lines.join("\n");
}

function renderTransitionResult(output: TransitionIssueOutput): string {
  return [
    `Transitioned ${output.issueKey} with "${output.transition.name}".`,
    `New status: ${output.issue.status?.name ?? output.transition.toStatus?.name ?? "Unknown"}`,
    `Comment added: ${output.commentAdded ? "yes" : "no"}`,
  ].join("\n");
}

function ensureTransitionInput(input: TransitionIssueInput): void {
  if (!input.transitionId && !input.transitionName) {
    throw new ValidationError("Provide either transitionId or transitionName.");
  }
}

function resolveTransition(
  transitions: readonly JiraTransition[],
  input: TransitionIssueInput,
  issueKey: string,
): JiraTransition {
  const availableTransitions = transitions.map((transition) => transition.name).join(", ");

  const transitionById = input.transitionId
    ? transitions.find((transition) => transition.id === input.transitionId)
    : undefined;
  const transitionByName = input.transitionName
    ? transitions.find((transition) => transition.name.toLowerCase() === input.transitionName?.toLowerCase())
    : undefined;

  if (input.transitionId && !transitionById) {
    throw new ValidationError(
      appendErrorDetail(
        `Transition id '${input.transitionId}' is not available for issue '${issueKey}'.`,
        availableTransitions ? `Available transitions: ${availableTransitions}.` : undefined,
      ),
    );
  }

  if (input.transitionName && !transitionByName) {
    throw new ValidationError(
      appendErrorDetail(
        `Transition '${input.transitionName}' is not available for issue '${issueKey}'.`,
        availableTransitions ? `Available transitions: ${availableTransitions}.` : undefined,
      ),
    );
  }

  if (transitionById && transitionByName && transitionById.id !== transitionByName.id) {
    throw new ValidationError("transitionId and transitionName refer to different Jira transitions.");
  }

  const selectedTransition = transitionById ?? transitionByName;
  if (!selectedTransition) {
    throw new ValidationError(
      appendErrorDetail(
        `No matching transition is available for issue '${issueKey}'.`,
        availableTransitions ? `Available transitions: ${availableTransitions}.` : undefined,
      ),
    );
  }

  return selectedTransition;
}

function rethrowJiraOperationError(error: unknown, message: string): never {
  if (error instanceof ValidationError) {
    throw error;
  }

  if (error instanceof ExternalServiceError) {
    throw new ExternalServiceError(appendErrorDetail(message, error.message), {
      statusCode: error.statusCode,
      details: error.details,
      exposeToClient: error.exposeToClient,
    });
  }

  if (error instanceof Error) {
    throw new ExternalServiceError(appendErrorDetail(message, error.message), {
      details: error.stack,
    });
  }

  throw new ExternalServiceError(message, {
    details: error,
    exposeToClient: false,
  });
}

export function loadJiraEnvironment(source: NodeJS.ProcessEnv = process.env): JiraEnvironment {
  const env = loadEnv(jiraEnvironmentShape, source);
  return {
    baseUrl: env.JIRA_BASE_URL,
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
    ...(env.JIRA_DEFAULT_PROJECT_KEY ? { defaultProjectKey: env.JIRA_DEFAULT_PROJECT_KEY } : {}),
  };
}

export class JiraRestClient implements JiraClient {
  private readonly environment: JiraEnvironment;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: JiraRestClientOptions) {
    this.environment = options.environment;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async searchIssues(request: JiraSearchRequest): Promise<JiraSearchResult> {
    const response = await this.requestJson("/rest/api/3/search", jiraSearchResponseSchema, {
      method: "POST",
      operation: "searching Jira issues",
      badRequestMessage: "Jira rejected the issue search request.",
      body: {
        jql: request.jql,
        startAt: request.startAt,
        maxResults: request.maxResults,
        fields: [...request.fields],
      },
    });

    return {
      startAt: response.startAt,
      maxResults: response.maxResults,
      total: response.total,
      issues: response.issues.map((issue) => normalizeIssueSummary(issue, this.environment.baseUrl)),
    };
  }

  public async getIssue(issueKey: string, fields: readonly string[] = DEFAULT_ISSUE_FIELDS): Promise<JiraIssueDetail> {
    const response = await this.requestJson(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      jiraIssueResponseSchema,
      {
        method: "GET",
        operation: `fetching Jira issue '${issueKey}'`,
        notFoundMessage: `Issue '${issueKey}' was not found in Jira.`,
        badRequestMessage: `Jira could not fetch issue '${issueKey}'.`,
        query: {
          fields: fields.join(","),
        },
      },
    );

    return normalizeIssueDetail(response, this.environment.baseUrl);
  }

  public async getTransitions(issueKey: string): Promise<readonly JiraTransition[]> {
    const response = await this.requestJson(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      jiraTransitionsResponseSchema,
      {
        method: "GET",
        operation: `listing transitions for Jira issue '${issueKey}'`,
        notFoundMessage: `Issue '${issueKey}' was not found in Jira.`,
        badRequestMessage: `Jira could not list transitions for issue '${issueKey}'.`,
      },
    );

    return response.transitions.map((transition) => normalizeTransition(transition));
  }

  public async transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void> {
    const body: {
      transition: {
        id: string;
      };
      update?: {
        comment: Array<{
          add: {
            body: ReturnType<typeof createJiraDocument>;
          };
        }>;
      };
    } = {
      transition: {
        id: transitionId,
      },
    };

    if (comment) {
      body.update = {
        comment: [
          {
            add: {
              body: createJiraDocument(comment),
            },
          },
        ],
      };
    }

    await this.requestVoid(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      operation: `transitioning Jira issue '${issueKey}'`,
      notFoundMessage: `Issue '${issueKey}' was not found in Jira.`,
      badRequestMessage: `Jira rejected the transition request for issue '${issueKey}'.`,
      body,
    });
  }

  public async getProject(projectKey: string): Promise<JiraProject> {
    const response = await this.requestJson(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      jiraProjectResponseSchema,
      {
        method: "GET",
        operation: `fetching Jira project '${projectKey}'`,
        notFoundMessage: `Project '${projectKey}' was not found in Jira.`,
        badRequestMessage: `Jira could not fetch project '${projectKey}'.`,
      },
    );

    return normalizeProject(response);
  }

  private createUrl(
    path: string,
    query?: Readonly<Record<string, string | number | boolean | undefined>>,
  ): URL {
    const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${this.environment.baseUrl}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private createHeaders(hasJsonBody: boolean): Headers {
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("authorization", createBasicAuthHeader(this.environment.email, this.environment.apiToken));

    if (hasJsonBody) {
      headers.set("content-type", "application/json");
    }

    return headers;
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    options: JiraRequestOptions,
  ): Promise<T> {
    const response = await this.request(path, options);
    const bodyText = await response.text();

    if (!bodyText.trim()) {
      throw new ExternalServiceError(appendErrorDetail(`Jira returned an empty response while ${options.operation}.`));
    }

    const payload = this.tryParseJson(bodyText);
    if (payload === undefined) {
      throw new ExternalServiceError(
        `Jira returned malformed JSON while ${options.operation}.`,
        {
          details: bodyText,
        },
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(`Jira returned an unexpected response while ${options.operation}.`, {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }

  private async requestVoid(path: string, options: JiraRequestOptions): Promise<void> {
    const response = await this.request(path, options);

    if (response.status === 204) {
      return;
    }

    const bodyText = await response.text();
    if (bodyText.trim().length > 0) {
      return;
    }
  }

  private async request(path: string, options: JiraRequestOptions): Promise<Response> {
    const url = this.createUrl(path, options.query);
    const hasBody = options.body !== undefined;
    const requestInit: RequestInit = {
      method: options.method,
      headers: this.createHeaders(hasBody),
    };

    if (hasBody) {
      requestInit.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      if (error instanceof Error) {
        throw new ExternalServiceError(
          appendErrorDetail(`Failed to reach Jira while ${options.operation}.`, error.message),
          {
            details: error.stack,
          },
        );
      }

      throw new ExternalServiceError(`Failed to reach Jira while ${options.operation}.`, {
        details: error,
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const bodyText = await response.text();
      const body = bodyText.trim() ? this.tryParseJson(bodyText) : undefined;
      const detail = formatJiraApiError(body, bodyText);

      switch (response.status) {
        case 400:
          throw new ValidationError(
            appendErrorDetail(options.badRequestMessage ?? "Jira rejected the request.", detail),
            body ?? bodyText,
          );
        case 401:
          throw new ExternalServiceError(
            appendErrorDetail(
              "Jira authentication failed. Check JIRA_EMAIL and JIRA_API_TOKEN.",
              detail,
            ),
            {
              statusCode: response.status,
              details: body ?? bodyText,
            },
          );
        case 403:
          throw new ExternalServiceError(
            appendErrorDetail("Jira denied access to the requested resource.", detail),
            {
              statusCode: response.status,
              details: body ?? bodyText,
            },
          );
        case 404:
          throw new ExternalServiceError(
            appendErrorDetail(options.notFoundMessage ?? "The requested Jira resource was not found.", detail),
            {
              statusCode: response.status,
              details: body ?? bodyText,
            },
          );
        case 429:
          throw new ExternalServiceError(
            appendErrorDetail("Jira rate limited the request. Retry later.", detail),
            {
              statusCode: response.status,
              details: body ?? bodyText,
            },
          );
        default:
          throw new ExternalServiceError(
            appendErrorDetail(
              `Jira request failed with status ${response.status} while ${options.operation}.`,
              detail,
            ),
            {
              statusCode: response.status,
              details: body ?? bodyText,
            },
          );
      }
    }

    return response;
  }

  private tryParseJson(text: string): unknown | undefined {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

export const metadata: ToolkitServerMetadata = {
  id: "jira",
  title: "Jira MCP Server",
  description: "Search Jira Cloud issues, inspect tickets, transition work, and fetch project context.",
  version: SERVER_VERSION,
  packageName: PACKAGE_NAME,
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/jira",
  envVarNames: REQUIRED_ENV_VAR_NAMES,
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

export class JiraServer extends ToolkitServer {
  private readonly client: JiraClient;
  private readonly environment: JiraEnvironment;

  public constructor(options: JiraServerOptions = {}) {
    const environment = options.environment ?? loadJiraEnvironment(options.envSource);
    super(metadata);
    this.environment = environment;
    this.client = options.client ?? new JiraRestClient({ environment });

    this.registerTool(this.createGetIssueTool());
    this.registerTool(this.createSearchIssuesTool());
    this.registerTool(this.createTransitionIssueTool());
    this.registerProjectResource();
    this.registerIncidentTriagePrompt();
  }

  public async readProjectResource(projectKey: string, uri: string = createProjectResourceUri(projectKey)) {
    try {
      const project = await this.client.getProject(projectKey);
      return this.createJsonResource(uri, {
        project,
      });
    } catch (error) {
      rethrowJiraOperationError(error, `Failed to read Jira project resource for '${projectKey}'.`);
    }
  }

  public buildIncidentTriagePrompt(args: IncidentTriagePromptArgs) {
    const effectiveProjectKey = args.projectKey ?? this.environment.defaultProjectKey;
    const projectResourceHint = effectiveProjectKey
      ? `Project resource: ${createProjectResourceUri(effectiveProjectKey)}`
      : "Project resource: provide a projectKey if you want project context.";
    const contextLines = [
      `Issue key: ${args.issueKey ?? "not provided"}`,
      `Project key: ${effectiveProjectKey ?? "not provided"}`,
      `Summary: ${args.summary}`,
      `Symptoms: ${args.symptoms}`,
      `Impact: ${args.impact ?? "not provided"}`,
      `Suspected service: ${args.suspectedService ?? "not provided"}`,
      `Environment: ${args.environment ?? "not provided"}`,
      projectResourceHint,
    ];

    return {
      messages: [
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: [
              "You are helping triage a Jira incident.",
              "Respond with:",
              "1. Estimated severity and blast radius.",
              "2. Immediate mitigation steps.",
              "3. Investigation plan with evidence to gather.",
              "4. Recommended Jira updates, including status, owner, and next comment.",
            ].join("\n"),
          },
        },
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: contextLines.join("\n"),
          },
        },
      ],
    };
  }

  private createSearchIssuesTool() {
    return defineTool({
      name: "search_issues",
      title: "Search Jira issues",
      description: "Search Jira issues with JQL or structured filters and return normalized issue summaries.",
      inputSchema: searchIssuesInputShape,
      outputSchema: searchIssuesOutputShape,
      handler: async (input, context) => {
        const request = createSearchRequest(input, this.environment);
        await context.log("info", `Searching Jira with JQL: ${request.jql}`);

        try {
          const result = await this.client.searchIssues(request);
          return {
            jql: request.jql,
            startAt: result.startAt,
            maxResults: result.maxResults,
            total: result.total,
            issues: [...result.issues],
          };
        } catch (error) {
          rethrowJiraOperationError(error, "Failed to search Jira issues.");
        }
      },
      renderText: (output) => renderSearchIssues(output),
    });
  }

  private createGetIssueTool() {
    return defineTool({
      name: "get_issue",
      title: "Get Jira issue",
      description: "Fetch a Jira issue with normalized fields, description text, and comments.",
      inputSchema: getIssueInputShape,
      outputSchema: getIssueOutputShape,
      handler: async (input, context) => {
        await context.log("info", `Fetching Jira issue ${input.issueKey}`);

        try {
          const issue = await this.client.getIssue(input.issueKey, input.fields ?? DEFAULT_ISSUE_FIELDS);
          return {
            issue,
          };
        } catch (error) {
          rethrowJiraOperationError(error, `Failed to fetch Jira issue '${input.issueKey}'.`);
        }
      },
      renderText: (output) => renderIssueDetail(output),
    });
  }

  private createTransitionIssueTool() {
    return defineTool({
      name: "transition_issue",
      title: "Transition Jira issue",
      description: "Safely resolve a Jira transition by name or id, apply it, and return the updated issue.",
      inputSchema: transitionIssueInputShape,
      outputSchema: transitionIssueOutputShape,
      handler: async (input, context) => {
        ensureTransitionInput(input);
        await context.log("info", `Resolving transitions for Jira issue ${input.issueKey}`);

        try {
          const transitions = await this.client.getTransitions(input.issueKey);
          const transition = resolveTransition(transitions, input, input.issueKey);
          await context.log("info", `Applying Jira transition '${transition.name}' (${transition.id})`);
          await this.client.transitionIssue(input.issueKey, transition.id, input.comment);
          const issue = await this.client.getIssue(input.issueKey);

          return {
            issueKey: input.issueKey,
            transition,
            commentAdded: input.comment !== undefined,
            availableTransitions: [...transitions],
            issue,
          };
        } catch (error) {
          rethrowJiraOperationError(error, `Failed to transition Jira issue '${input.issueKey}'.`);
        }
      },
      renderText: (output) => renderTransitionResult(output),
    });
  }

  private registerProjectResource(): void {
    this.registerTemplateResource(
      "project",
      "jira://projects/{projectKey}",
      {
        title: "Jira project",
        description: "Return normalized Jira project metadata as JSON.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const parsed = projectResourceParamsSchema.safeParse({
          projectKey: Array.isArray(variables.projectKey) ? variables.projectKey[0] : variables.projectKey,
        });

        if (!parsed.success) {
          throw new ValidationError("Invalid Jira project resource URI.", parsed.error.flatten());
        }

        return this.readProjectResource(parsed.data.projectKey, uri.toString());
      },
    );
  }

  private registerIncidentTriagePrompt(): void {
    this.registerPrompt(
      "incident_triage",
      {
        title: "Incident triage",
        description: "Generate an incident-triage prompt from Jira issue context.",
        argsSchema: incidentTriagePromptArgsShape,
      },
      (args) => this.buildIncidentTriagePrompt(args),
    );
  }
}

export function createServer(options: JiraServerOptions = {}): JiraServer {
  return new JiraServer(options);
}

const runtimeRegistration = {
  createServer,
  serverCard,
} satisfies ToolkitRuntimeRegistration;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);
  await runToolkitServer(runtimeRegistration, runtimeOptions);
}

export default runtimeRegistration;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
