import { pathToFileURL } from "node:url";

import {
  ConfigurationError,
  createServerCard,
  defineTool,
  ExternalServiceError,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  ValidationError,
  type InferShape,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { Octokit, RequestError } from "octokit";
import { z } from "zod";

const TOOL_NAMES = ["get_pull_request", "list_workflow_runs", "search_repositories"] as const;
const RESOURCE_NAMES = ["repository"] as const;
const PROMPT_NAMES = ["triage_pull_request"] as const;
const REPOSITORY_RESOURCE_TEMPLATE = "github://repos/{owner}/{repo}";

const REPOSITORY_SEARCH_SORT_VALUES = ["stars", "forks", "help-wanted-issues", "updated"] as const;
const SORT_ORDER_VALUES = ["asc", "desc"] as const;
const WORKFLOW_RUN_STATUS_VALUES = [
  "completed",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "pending",
  "queued",
  "requested",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "in_progress",
  "waiting",
] as const;
const TRIAGE_FOCUS_VALUES = ["merge-readiness", "risk-review", "test-gaps", "release-notes"] as const;

const sortOrderSchema = z.enum(SORT_ORDER_VALUES);
const repositorySearchSortSchema = z.enum(REPOSITORY_SEARCH_SORT_VALUES);
const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUS_VALUES);
const triageFocusSchema = z.enum(TRIAGE_FOCUS_VALUES);

const ownerSummarySchema = z.object({
  login: z.string().min(1),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
});

const labelSummarySchema = z.object({
  name: z.string().min(1),
  color: z.string().nullable(),
});

const repositorySummarySchema = z.object({
  owner: ownerSummarySchema,
  name: z.string().min(1),
  fullName: z.string().min(1),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  isFork: z.boolean(),
  language: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  topics: z.array(z.string()),
  defaultBranch: z.string().min(1),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  updatedAt: z.string().min(1),
  pushedAt: z.string().nullable(),
});

const workflowRunSummarySchema = z.object({
  id: z.number().int().positive(),
  workflowId: z.number().int().positive(),
  runNumber: z.number().int().nonnegative(),
  name: z.string().nullable(),
  displayTitle: z.string().min(1),
  event: z.string().min(1),
  branch: z.string().nullable(),
  commitSha: z.string().min(1),
  commitMessage: z.string().nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  actor: ownerSummarySchema.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const searchRepositoriesInputShape = {
  query: z.string().trim().min(1),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(10),
  sort: repositorySearchSortSchema.optional(),
  order: sortOrderSchema.default("desc"),
};

const searchRepositoriesOutputShape = {
  query: z.string().min(1),
  totalCount: z.number().int().nonnegative(),
  incompleteResults: z.boolean(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  repositories: z.array(repositorySummarySchema),
};

const getPullRequestInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  pullNumber: z.coerce.number().int().positive(),
};

const getPullRequestOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  title: z.string().min(1),
  state: z.string().min(1),
  body: z.string().nullable(),
  isDraft: z.boolean(),
  isMerged: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().nullable(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  author: ownerSummarySchema.nullable(),
  labels: z.array(labelSummarySchema),
  requestedReviewers: z.array(ownerSummarySchema),
  comments: z.number().int().nonnegative(),
  reviewComments: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  mergedAt: z.string().nullable(),
};

const listWorkflowRunsInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  event: z.string().trim().min(1).optional(),
  status: workflowRunStatusSchema.optional(),
  excludePullRequests: z.boolean().default(false),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(10),
};

const listWorkflowRunsOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  runs: z.array(workflowRunSummarySchema),
};

const triagePullRequestArgsShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  pullNumber: z.coerce.number().int().positive(),
  focus: triageFocusSchema.default("merge-readiness"),
  additionalContext: z.string().trim().min(1).optional(),
};

const gitHubEnvShape = {
  GITHUB_TOKEN: z.string().trim().min(1),
  GITHUB_DEFAULT_OWNER: z.string().trim().min(1).optional(),
  GITHUB_DEFAULT_REPO: z.string().trim().min(1).optional(),
  GITHUB_API_BASE_URL: z.string().trim().url().optional(),
};

const gitHubConfigSchema = z.object({
  token: z.string().trim().min(1),
  defaultOwner: z.string().trim().min(1).optional(),
  defaultRepo: z.string().trim().min(1).optional(),
  apiBaseUrl: z.string().trim().url().optional(),
});

export type SearchRepositoriesInput = InferShape<typeof searchRepositoriesInputShape>;
export type SearchRepositoriesOutput = InferShape<typeof searchRepositoriesOutputShape>;
export type GetPullRequestInput = InferShape<typeof getPullRequestInputShape>;
export type GetPullRequestOutput = InferShape<typeof getPullRequestOutputShape>;
export type ListWorkflowRunsInput = InferShape<typeof listWorkflowRunsInputShape>;
export type ListWorkflowRunsOutput = InferShape<typeof listWorkflowRunsOutputShape>;
export type TriagePullRequestArgs = InferShape<typeof triagePullRequestArgsShape>;
export type GitHubServerConfig = z.infer<typeof gitHubConfigSchema>;

type RepositorySearchSort = (typeof REPOSITORY_SEARCH_SORT_VALUES)[number];
type SortOrder = (typeof SORT_ORDER_VALUES)[number];
type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS_VALUES)[number];
type RequestParameterValue = boolean | number | string | undefined;

interface GitHubUser {
  login: string;
  html_url: string;
  url: string;
}

interface GitHubLicense {
  spdx_id: string | null;
  name: string;
}

interface GitHubRepositorySummaryRecord {
  owner: GitHubUser;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics?: string[];
  default_branch: string;
  html_url: string;
  url: string;
  updated_at: string;
  pushed_at: string | null;
}

interface GitHubRepositoryRecord extends GitHubRepositorySummaryRecord {
  visibility?: string | null;
  watchers_count?: number;
  clone_url?: string;
  ssh_url?: string;
  homepage?: string | null;
  disabled?: boolean;
  has_issues?: boolean;
  has_projects?: boolean;
  has_wiki?: boolean;
  has_discussions?: boolean;
  created_at?: string;
  license?: GitHubLicense | null;
}

interface GitHubLabel {
  name?: string;
  color?: string | null;
}

interface GitHubBranchReference {
  ref: string;
  sha: string;
}

interface GitHubPullRequestRecord {
  number: number;
  title: string;
  state: string;
  body: string | null;
  draft?: boolean | null;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state?: string | null;
  html_url: string;
  url: string;
  user: GitHubUser | null;
  labels: GitHubLabel[];
  requested_reviewers: GitHubUser[];
  comments: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  head: GitHubBranchReference;
  base: GitHubBranchReference;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

interface GitHubHeadCommit {
  message?: string | null;
}

interface GitHubWorkflowRunRecord {
  id: number;
  workflow_id: number;
  run_number: number;
  name: string | null;
  display_title?: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  url: string;
  actor: GitHubUser | null;
  head_commit?: GitHubHeadCommit | null;
  created_at: string;
  updated_at: string;
}

interface MinimalGitHubUser {
  login: string;
  html_url: string;
  url: string;
}

type SearchRepositoriesParams = Record<string, RequestParameterValue> & {
  q: string;
  page?: number;
  per_page?: number;
  sort?: RepositorySearchSort;
  order?: SortOrder;
};

interface SearchRepositoriesResponse {
  data: {
    total_count: number;
    incomplete_results: boolean;
    items: GitHubRepositorySummaryRecord[];
  };
}

type GetPullRequestParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  pull_number: number;
};

interface GetPullRequestResponse {
  data: GitHubPullRequestRecord;
}

type ListWorkflowRunsParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  actor?: string;
  branch?: string;
  event?: string;
  status?: WorkflowRunStatus;
  exclude_pull_requests?: boolean;
  page?: number;
  per_page?: number;
};

interface ListWorkflowRunsResponse {
  data: {
    total_count: number;
    workflow_runs: GitHubWorkflowRunRecord[];
  };
}

type GetRepositoryParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
};

interface GetRepositoryResponse {
  data: GitHubRepositoryRecord;
}

export interface GitHubApiClient {
  search: {
    repos: (params: SearchRepositoriesParams) => Promise<SearchRepositoriesResponse>;
  };
  pulls: {
    get: (params: GetPullRequestParams) => Promise<GetPullRequestResponse>;
  };
  actions: {
    listWorkflowRunsForRepo: (params: ListWorkflowRunsParams) => Promise<ListWorkflowRunsResponse>;
  };
  repos: {
    get: (params: GetRepositoryParams) => Promise<GetRepositoryResponse>;
  };
}

export interface GitHubServerDependencies {
  client: GitHubApiClient;
  config: GitHubServerConfig;
}

export interface GitHubServerOptions {
  client?: GitHubApiClient;
  config?: GitHubServerConfig;
  envSource?: NodeJS.ProcessEnv;
}

export const metadata: ToolkitServerMetadata = {
  id: "github",
  title: "GitHub MCP Server",
  description:
    "Repository search, pull request lookup, workflow run inspection, repository resources, and triage prompts for GitHub.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-github",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/github",
  envVarNames: ["GITHUB_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

function normalizeGitHubConfig(config: GitHubServerConfig): GitHubServerConfig {
  const result = gitHubConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigurationError("GitHub server configuration is invalid.", result.error.flatten());
  }

  const normalizedConfig = result.data;
  const hasDefaultOwner = normalizedConfig.defaultOwner !== undefined;
  const hasDefaultRepo = normalizedConfig.defaultRepo !== undefined;
  if (hasDefaultOwner !== hasDefaultRepo) {
    throw new ConfigurationError(
      "GITHUB_DEFAULT_OWNER and GITHUB_DEFAULT_REPO must either both be set or both be omitted.",
    );
  }

  return normalizedConfig;
}

function loadGitHubConfig(source?: NodeJS.ProcessEnv): GitHubServerConfig {
  const env = loadEnv(gitHubEnvShape, source);
  const config: GitHubServerConfig = {
    token: env.GITHUB_TOKEN,
  };

  if (env.GITHUB_DEFAULT_OWNER !== undefined) {
    config.defaultOwner = env.GITHUB_DEFAULT_OWNER;
  }

  if (env.GITHUB_DEFAULT_REPO !== undefined) {
    config.defaultRepo = env.GITHUB_DEFAULT_REPO;
  }

  if (env.GITHUB_API_BASE_URL !== undefined) {
    config.apiBaseUrl = env.GITHUB_API_BASE_URL;
  }

  return normalizeGitHubConfig(config);
}

function toRequiredGitHubUser(user: MinimalGitHubUser | null | undefined, operation: string): GitHubUser {
  if (!user) {
    throw new ExternalServiceError(`GitHub returned incomplete user data while ${operation}.`, {
      exposeToClient: false,
    });
  }

  return {
    login: user.login,
    html_url: user.html_url,
    url: user.url,
  };
}

function createGitHubApiClient(config: GitHubServerConfig): GitHubApiClient {
  const userAgent = `${metadata.packageName}/${metadata.version}`;
  const octokit = config.apiBaseUrl
    ? new Octokit({ auth: config.token, baseUrl: config.apiBaseUrl, userAgent })
    : new Octokit({ auth: config.token, userAgent });

  return {
    search: {
      repos: async (params) => {
        const response = await octokit.rest.search.repos(params);

        return {
          data: {
            total_count: response.data.total_count,
            incomplete_results: response.data.incomplete_results,
            items: response.data.items.map((item) => ({
              owner: toRequiredGitHubUser(item.owner, "searching repositories"),
              name: item.name,
              full_name: item.full_name,
              description: item.description,
              private: item.private,
              archived: item.archived,
              fork: item.fork,
              language: item.language,
              stargazers_count: item.stargazers_count,
              forks_count: item.forks_count,
              open_issues_count: item.open_issues_count,
              topics: item.topics ?? [],
              default_branch: item.default_branch,
              html_url: item.html_url,
              url: item.url,
              updated_at: item.updated_at,
              pushed_at: item.pushed_at ?? null,
            })),
          },
        };
      },
    },
    pulls: {
      get: async (params) => {
        const response = await octokit.rest.pulls.get(params);

        return {
          data: {
            number: response.data.number,
            title: response.data.title,
            state: response.data.state,
            body: response.data.body,
            draft: response.data.draft ?? false,
            merged: response.data.merged,
            mergeable: response.data.mergeable,
            mergeable_state: response.data.mergeable_state ?? null,
            html_url: response.data.html_url,
            url: response.data.url,
            user: response.data.user ? toRequiredGitHubUser(response.data.user, "loading a pull request") : null,
            labels: response.data.labels.map((label) => ({
              name: label.name,
              color: label.color ?? null,
            })),
            requested_reviewers: (response.data.requested_reviewers ?? []).map((reviewer) =>
              toRequiredGitHubUser(reviewer, "loading requested reviewers"),
            ),
            comments: response.data.comments,
            review_comments: response.data.review_comments,
            commits: response.data.commits,
            additions: response.data.additions,
            deletions: response.data.deletions,
            changed_files: response.data.changed_files,
            head: {
              ref: response.data.head.ref,
              sha: response.data.head.sha,
            },
            base: {
              ref: response.data.base.ref,
              sha: response.data.base.sha,
            },
            created_at: response.data.created_at,
            updated_at: response.data.updated_at,
            merged_at: response.data.merged_at,
          },
        };
      },
    },
    actions: {
      listWorkflowRunsForRepo: async (params) => {
        const response = await octokit.rest.actions.listWorkflowRunsForRepo(params);

        return {
          data: {
            total_count: response.data.total_count,
            workflow_runs: response.data.workflow_runs.map((run) => ({
              id: run.id,
              workflow_id: run.workflow_id,
              run_number: run.run_number,
              name: run.name ?? null,
              display_title: run.display_title ?? null,
              event: run.event,
              head_branch: run.head_branch ?? null,
              head_sha: run.head_sha,
              status: run.status ?? null,
              conclusion: run.conclusion ?? null,
              html_url: run.html_url,
              url: run.url,
              actor: run.actor ? toRequiredGitHubUser(run.actor, "loading workflow runs") : null,
              head_commit: run.head_commit ? { message: run.head_commit.message ?? null } : null,
              created_at: run.created_at,
              updated_at: run.updated_at,
            })),
          },
        };
      },
    },
    repos: {
      get: async (params) => {
        const response = await octokit.rest.repos.get(params);

        return {
          data: {
            owner: toRequiredGitHubUser(response.data.owner, "loading a repository"),
            name: response.data.name,
            full_name: response.data.full_name,
            description: response.data.description,
            visibility: response.data.visibility ?? null,
            private: response.data.private,
            archived: response.data.archived,
            disabled: response.data.disabled,
            fork: response.data.fork,
            language: response.data.language,
            default_branch: response.data.default_branch,
            topics: response.data.topics ?? [],
            stargazers_count: response.data.stargazers_count,
            watchers_count: response.data.watchers_count,
            forks_count: response.data.forks_count,
            open_issues_count: response.data.open_issues_count,
            html_url: response.data.html_url,
            url: response.data.url,
            clone_url: response.data.clone_url,
            ssh_url: response.data.ssh_url,
            homepage: response.data.homepage ?? null,
            has_issues: response.data.has_issues,
            has_projects: response.data.has_projects,
            has_wiki: response.data.has_wiki,
            has_discussions: response.data.has_discussions,
            created_at: response.data.created_at,
            updated_at: response.data.updated_at,
            pushed_at: response.data.pushed_at,
            license: response.data.license
              ? {
                  spdx_id: response.data.license.spdx_id,
                  name: response.data.license.name,
                }
              : null,
          },
        };
      },
    },
  };
}

type OwnerSummary = z.infer<typeof ownerSummarySchema>;
type LabelSummary = z.infer<typeof labelSummarySchema>;
type RepositorySummary = z.infer<typeof repositorySummarySchema>;
type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;

function toOwnerSummary(user: GitHubUser): OwnerSummary {
  return {
    login: user.login,
    htmlUrl: user.html_url,
    apiUrl: user.url,
  };
}

function toNullableOwnerSummary(user: GitHubUser | null): OwnerSummary | null {
  return user ? toOwnerSummary(user) : null;
}

function toLabelSummary(label: GitHubLabel): LabelSummary {
  return {
    name: label.name && label.name.length > 0 ? label.name : "unlabeled",
    color: label.color ?? null,
  };
}

function toRepositorySummary(record: GitHubRepositorySummaryRecord): RepositorySummary {
  return {
    owner: toOwnerSummary(record.owner),
    name: record.name,
    fullName: record.full_name,
    description: record.description,
    isPrivate: record.private,
    isArchived: record.archived,
    isFork: record.fork,
    language: record.language,
    stars: record.stargazers_count,
    forks: record.forks_count,
    openIssues: record.open_issues_count,
    topics: record.topics ?? [],
    defaultBranch: record.default_branch,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    updatedAt: record.updated_at,
    pushedAt: record.pushed_at,
  };
}

function toWorkflowRunSummary(record: GitHubWorkflowRunRecord): WorkflowRunSummary {
  return {
    id: record.id,
    workflowId: record.workflow_id,
    runNumber: record.run_number,
    name: record.name,
    displayTitle: record.display_title ?? record.name ?? `Run ${record.run_number}`,
    event: record.event,
    branch: record.head_branch,
    commitSha: record.head_sha,
    commitMessage: record.head_commit?.message ?? null,
    status: record.status,
    conclusion: record.conclusion,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    actor: toNullableOwnerSummary(record.actor),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toRepositoryResourcePayload(record: GitHubRepositoryRecord) {
  return {
    owner: toOwnerSummary(record.owner),
    name: record.name,
    fullName: record.full_name,
    description: record.description,
    visibility: record.visibility ?? null,
    isPrivate: record.private,
    isArchived: record.archived,
    isDisabled: record.disabled ?? false,
    isFork: record.fork,
    language: record.language,
    defaultBranch: record.default_branch,
    topics: record.topics ?? [],
    stars: record.stargazers_count,
    watchers: record.watchers_count ?? record.stargazers_count,
    forks: record.forks_count,
    openIssues: record.open_issues_count,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    cloneUrl: record.clone_url ?? null,
    sshUrl: record.ssh_url ?? null,
    homepage: record.homepage ?? null,
    hasIssues: record.has_issues ?? false,
    hasProjects: record.has_projects ?? false,
    hasWiki: record.has_wiki ?? false,
    hasDiscussions: record.has_discussions ?? false,
    license: record.license?.spdx_id ?? record.license?.name ?? null,
    createdAt: record.created_at ?? null,
    updatedAt: record.updated_at,
    pushedAt: record.pushed_at,
  };
}

function renderRepositorySearch(output: SearchRepositoriesOutput): string {
  const lines = output.repositories.map((repository) => {
    const languageSuffix = repository.language ? ` • ${repository.language}` : "";
    const descriptionSuffix = repository.description ? ` — ${repository.description}` : "";
    return `- ${repository.fullName} (${repository.stars}★${languageSuffix})${descriptionSuffix}`;
  });

  return [`Found ${output.totalCount} repositories for "${output.query}".`, ...lines].join("\n");
}

function renderPullRequest(output: GetPullRequestOutput): string {
  const labels = output.labels.length > 0 ? output.labels.map((label) => label.name).join(", ") : "none";
  const reviewers =
    output.requestedReviewers.length > 0
      ? output.requestedReviewers.map((reviewer) => reviewer.login).join(", ")
      : "none";

  return [
    `Pull request #${output.pullNumber} in ${output.owner}/${output.repo}: ${output.title}`,
    `State: ${output.state}${output.isDraft ? " (draft)" : ""}${output.isMerged ? " • merged" : ""}`,
    `Mergeability: ${output.mergeableState ?? "unknown"}`,
    `Labels: ${labels}`,
    `Requested reviewers: ${reviewers}`,
    `Changes: +${output.additions} / -${output.deletions} across ${output.changedFiles} files`,
    `URL: ${output.htmlUrl}`,
  ].join("\n");
}

function renderWorkflowRuns(output: ListWorkflowRunsOutput): string {
  const lines = output.runs.map((run) => {
    const status = run.status ?? "unknown";
    const conclusion = run.conclusion ? `/${run.conclusion}` : "";
    const branch = run.branch ?? "unknown-branch";
    return `- #${run.runNumber} ${run.displayTitle} [${status}${conclusion}] on ${branch}`;
  });

  return [`Found ${output.totalCount} workflow runs for ${output.owner}/${output.repo}.`, ...lines].join("\n");
}

function getTemplateParam(params: Record<string, string | string[]>, key: string): string {
  const value = params[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && value[0] !== undefined && value[0].length > 0) {
    return value[0];
  }

  throw new ValidationError(`Missing '${key}' in repository resource URI.`);
}

function sortNames(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

function formatRequestErrorMessage(operation: string, error: RequestError): string {
  switch (error.status) {
    case 401:
      return `GitHub authentication failed while ${operation}. Check GITHUB_TOKEN.`;
    case 403:
      return error.message.toLowerCase().includes("rate limit")
        ? `GitHub rate limits were exceeded while ${operation}.`
        : `GitHub access was denied while ${operation}.`;
    case 404:
      return `GitHub could not find the requested resource while ${operation}.`;
    default:
      return `GitHub API request failed while ${operation}: ${error.message}`;
  }
}

export class GitHubServer extends ToolkitServer {
  private readonly client: GitHubApiClient;
  private readonly config: GitHubServerConfig;

  public constructor(dependencies: GitHubServerDependencies) {
    const config = normalizeGitHubConfig(dependencies.config);

    super(metadata);

    this.client = dependencies.client;
    this.config = config;

    this.registerSearchRepositoriesTool();
    this.registerGetPullRequestTool();
    this.registerListWorkflowRunsTool();
    this.registerRepositoryResource();
    this.registerTriagePrompt();
    this.assertMetadataMatchesRegistrations();
  }

  private assertMetadataMatchesRegistrations(): void {
    const actualTools = this.getToolNames();
    const actualResources = this.getResourceNames();
    const actualPrompts = this.getPromptNames();

    if (JSON.stringify(sortNames(actualTools)) !== JSON.stringify(sortNames(metadata.toolNames))) {
      throw new ConfigurationError("metadata.toolNames must match the registered tool names.", {
        expected: metadata.toolNames,
        actual: actualTools,
      });
    }

    if (JSON.stringify(sortNames(actualResources)) !== JSON.stringify(sortNames(metadata.resourceNames))) {
      throw new ConfigurationError("metadata.resourceNames must match the registered resource names.", {
        expected: metadata.resourceNames,
        actual: actualResources,
      });
    }

    if (JSON.stringify(sortNames(actualPrompts)) !== JSON.stringify(sortNames(metadata.promptNames))) {
      throw new ConfigurationError("metadata.promptNames must match the registered prompt names.", {
        expected: metadata.promptNames,
        actual: actualPrompts,
      });
    }
  }

  private resolveRepositoryTarget(owner?: string, repo?: string): { owner: string; repo: string } {
    const resolvedOwner = owner ?? this.config.defaultOwner;
    const resolvedRepo = repo ?? this.config.defaultRepo;

    if (!resolvedOwner || !resolvedRepo) {
      throw new ValidationError(
        "Repository owner and repo are required. Provide them explicitly or set GITHUB_DEFAULT_OWNER and GITHUB_DEFAULT_REPO.",
      );
    }

    return {
      owner: resolvedOwner,
      repo: resolvedRepo,
    };
  }

  private async withGitHubApi<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
        throw error;
      }

      if (error instanceof RequestError) {
        throw new ExternalServiceError(formatRequestErrorMessage(operation, error), {
          statusCode: error.status >= 400 ? error.status : 502,
          details: {
            status: error.status,
            message: error.message,
          },
        });
      }

      throw new ExternalServiceError(`Unexpected GitHub error while ${operation}.`, {
        details: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        exposeToClient: false,
      });
    }
  }

  private registerSearchRepositoriesTool(): void {
    this.registerTool(
      defineTool({
        name: "search_repositories",
        title: "Search GitHub repositories",
        description: "Search public or private repositories visible to the configured GitHub token.",
        inputSchema: searchRepositoriesInputShape,
        outputSchema: searchRepositoriesOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          await context.log("info", `Searching GitHub repositories for "${input.query}"`);

          const params: SearchRepositoriesParams = {
            q: input.query,
            page: input.page,
            per_page: input.perPage,
          };

          if (input.sort !== undefined) {
            params.sort = input.sort;
            params.order = input.order;
          }

          const response = await this.withGitHubApi("searching repositories", () => this.client.search.repos(params));

          return {
            query: input.query,
            totalCount: response.data.total_count,
            incompleteResults: response.data.incomplete_results,
            page: input.page,
            perPage: input.perPage,
            repositories: response.data.items.map((repository) => toRepositorySummary(repository)),
          };
        },
        renderText: renderRepositorySearch,
      }),
    );
  }

  private registerGetPullRequestTool(): void {
    this.registerTool(
      defineTool({
        name: "get_pull_request",
        title: "Get a pull request",
        description: "Fetch a pull request with mergeability, reviewer, and diff summary details.",
        inputSchema: getPullRequestInputShape,
        outputSchema: getPullRequestOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log(
            "info",
            `Loading pull request #${input.pullNumber} for ${repository.owner}/${repository.repo}`,
          );

          const response = await this.withGitHubApi("loading a pull request", () =>
            this.client.pulls.get({
              owner: repository.owner,
              repo: repository.repo,
              pull_number: input.pullNumber,
            }),
          );

          return {
            owner: repository.owner,
            repo: repository.repo,
            pullNumber: response.data.number,
            title: response.data.title,
            state: response.data.state,
            body: response.data.body,
            isDraft: response.data.draft ?? false,
            isMerged: response.data.merged,
            mergeable: response.data.mergeable,
            mergeableState: response.data.mergeable_state ?? null,
            htmlUrl: response.data.html_url,
            apiUrl: response.data.url,
            author: toNullableOwnerSummary(response.data.user),
            labels: response.data.labels.map((label) => toLabelSummary(label)),
            requestedReviewers: response.data.requested_reviewers.map((reviewer) => toOwnerSummary(reviewer)),
            comments: response.data.comments,
            reviewComments: response.data.review_comments,
            commits: response.data.commits,
            additions: response.data.additions,
            deletions: response.data.deletions,
            changedFiles: response.data.changed_files,
            headRef: response.data.head.ref,
            headSha: response.data.head.sha,
            baseRef: response.data.base.ref,
            baseSha: response.data.base.sha,
            createdAt: response.data.created_at,
            updatedAt: response.data.updated_at,
            mergedAt: response.data.merged_at,
          };
        },
        renderText: renderPullRequest,
      }),
    );
  }

  private registerListWorkflowRunsTool(): void {
    this.registerTool(
      defineTool({
        name: "list_workflow_runs",
        title: "List workflow runs",
        description: "List recent GitHub Actions workflow runs for a repository with optional branch and status filters.",
        inputSchema: listWorkflowRunsInputShape,
        outputSchema: listWorkflowRunsOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Listing workflow runs for ${repository.owner}/${repository.repo}`);

          const params: ListWorkflowRunsParams = {
            owner: repository.owner,
            repo: repository.repo,
            page: input.page,
            per_page: input.perPage,
            exclude_pull_requests: input.excludePullRequests,
          };

          if (input.actor !== undefined) {
            params.actor = input.actor;
          }

          if (input.branch !== undefined) {
            params.branch = input.branch;
          }

          if (input.event !== undefined) {
            params.event = input.event;
          }

          if (input.status !== undefined) {
            params.status = input.status;
          }

          const response = await this.withGitHubApi("listing workflow runs", () =>
            this.client.actions.listWorkflowRunsForRepo(params),
          );

          return {
            owner: repository.owner,
            repo: repository.repo,
            totalCount: response.data.total_count,
            page: input.page,
            perPage: input.perPage,
            runs: response.data.workflow_runs.map((run) => toWorkflowRunSummary(run)),
          };
        },
        renderText: renderWorkflowRuns,
      }),
    );
  }

  private registerRepositoryResource(): void {
    this.registerTemplateResource(
      "repository",
      REPOSITORY_RESOURCE_TEMPLATE,
      {
        title: "GitHub repository",
        description: "Repository metadata for a GitHub repository.",
        mimeType: "application/json",
      },
      async (uri, params) => {
        const repository = this.resolveRepositoryTarget(getTemplateParam(params, "owner"), getTemplateParam(params, "repo"));
        const response = await this.withGitHubApi("loading a repository resource", () =>
          this.client.repos.get({
            owner: repository.owner,
            repo: repository.repo,
          }),
        );

        return this.createJsonResource(uri.toString(), toRepositoryResourcePayload(response.data));
      },
    );
  }

  private registerTriagePrompt(): void {
    this.registerPrompt(
      "triage_pull_request",
      {
        title: "Triage a pull request",
        description: "Create a structured review plan for triaging a GitHub pull request.",
        argsSchema: triagePullRequestArgsShape,
      },
      async (args) => {
        const repository = this.resolveRepositoryTarget(args.owner, args.repo);
        const promptLines = [
          `Triage GitHub pull request #${args.pullNumber} in ${repository.owner}/${repository.repo}.`,
          `Focus area: ${args.focus}.`,
          "",
          "Use these MCP capabilities before writing your conclusion:",
          `1. Read the repository resource at ${REPOSITORY_RESOURCE_TEMPLATE.replace("{owner}", repository.owner).replace("{repo}", repository.repo)}.`,
          `2. Call get_pull_request with {"owner":"${repository.owner}","repo":"${repository.repo}","pullNumber":${args.pullNumber}}.`,
          `3. Call list_workflow_runs with {"owner":"${repository.owner}","repo":"${repository.repo}","perPage":10}.`,
          "",
          "Deliver a concise triage report with:",
          "- merge blockers",
          "- test or workflow concerns",
          "- requested reviewer follow-ups",
          "- release or rollout considerations",
        ];

        if (args.additionalContext !== undefined) {
          promptLines.push("", `Additional context: ${args.additionalContext}`);
        }

        return this.createTextPrompt(promptLines.join("\n"));
      },
    );
  }
}

export function createServer(options: GitHubServerOptions = {}): GitHubServer {
  const config = options.config ? normalizeGitHubConfig(options.config) : loadGitHubConfig(options.envSource);
  const client = options.client ?? createGitHubApiClient(config);

  return new GitHubServer({
    client,
    config,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);

  await runToolkitServer(
    {
      createServer: () => createServer(),
      serverCard,
    },
    runtimeOptions,
  );
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isEntrypoint()) {
  void main().catch((error: unknown) => {
    const normalized = normalizeError(error);
    console.error(`${normalized.code}: ${normalized.toClientMessage()}`);
    process.exitCode = 1;
  });
}
