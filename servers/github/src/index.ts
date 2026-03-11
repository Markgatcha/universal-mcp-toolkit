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

const TOOL_NAMES = [
  "comment_on_issue",
  "create_issue",
  "create_or_update_file",
  "create_pull_request",
  "get_file_contents",
  "get_pull_request",
  "list_commits",
  "list_issues",
  "list_releases",
  "list_workflow_runs",
  "merge_pull_request",
  "search_repositories",
] as const;
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
const ISSUE_STATE_VALUES = ["open", "closed", "all"] as const;
const MERGE_METHOD_VALUES = ["merge", "squash", "rebase"] as const;
const CREATE_OR_UPDATE_FILE_OPERATION_VALUES = ["created", "updated"] as const;
const GITHUB_FILE_CONTENT_TYPE = "file";
const GITHUB_CONTENTS_BASE64_ENCODING = "base64";

const sortOrderSchema = z.enum(SORT_ORDER_VALUES);
const repositorySearchSortSchema = z.enum(REPOSITORY_SEARCH_SORT_VALUES);
const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUS_VALUES);
const triageFocusSchema = z.enum(TRIAGE_FOCUS_VALUES);
const issueStateSchema = z.enum(ISSUE_STATE_VALUES);
const mergeMethodSchema = z.enum(MERGE_METHOD_VALUES);
const createOrUpdateFileOperationSchema = z.enum(CREATE_OR_UPDATE_FILE_OPERATION_VALUES);

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

const issueSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: z.string().min(1),
  author: ownerSummarySchema.nullable(),
  labels: z.array(labelSummarySchema),
  comments: z.number().int().nonnegative(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const commitSummarySchema = z.object({
  sha: z.string().min(1),
  message: z.string().min(1),
  author: ownerSummarySchema.nullable(),
  authorName: z.string().nullable(),
  date: z.string().nullable(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
});

const releaseSummarySchema = z.object({
  id: z.number().int().positive(),
  tagName: z.string().min(1),
  name: z.string().nullable(),
  body: z.string().nullable(),
  isDraft: z.boolean(),
  isPrerelease: z.boolean(),
  publishedAt: z.string().nullable(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
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

const listIssuesInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  labels: z.array(z.string().trim().min(1)).default([]),
  assignee: z.string().trim().min(1).optional(),
  state: issueStateSchema.default("open"),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(10),
};

const listIssuesOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  stateFilter: issueStateSchema,
  assigneeFilter: z.string().nullable(),
  labelFilter: z.array(z.string().min(1)),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(issueSummarySchema),
};

const createIssueInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  body: z.string(),
  labels: z.array(z.string().trim().min(1)).default([]),
};

const createIssueOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  title: z.string().min(1),
  state: z.string().min(1),
  body: z.string().nullable(),
  author: ownerSummarySchema.nullable(),
  labels: z.array(labelSummarySchema),
  comments: z.number().int().nonnegative(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

const commentOnIssueInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  issueNumber: z.coerce.number().int().positive(),
  body: z.string().min(1),
};

const commentOnIssueOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  commentId: z.number().int().positive(),
  body: z.string(),
  author: ownerSummarySchema.nullable(),
  htmlUrl: z.string().url(),
  apiUrl: z.string().url(),
  issueApiUrl: z.string().url(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

const listCommitsInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  sha: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(10),
};

const listCommitsOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().nullable(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  commits: z.array(commitSummarySchema),
};

const createPullRequestInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  body: z.string(),
  head: z.string().trim().min(1),
  base: z.string().trim().min(1),
  draft: z.boolean().default(false),
};

const createPullRequestOutputShape = getPullRequestOutputShape;

const mergePullRequestInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  pullNumber: z.coerce.number().int().positive(),
  mergeMethod: mergeMethodSchema.default("merge"),
};

const mergePullRequestOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  title: z.string().min(1),
  mergeMethod: mergeMethodSchema,
  merged: z.boolean(),
  message: z.string().min(1),
  sha: z.string().min(1),
};

const getFileContentsInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
};

const getFileContentsOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().min(1).nullable(),
  sha: z.string().min(1),
  size: z.number().int().nonnegative(),
  encoding: z.string().min(1),
  content: z.string(),
  htmlUrl: z.string().url().nullable(),
  downloadUrl: z.string().url().nullable(),
  apiUrl: z.string().url(),
  gitUrl: z.string().url().nullable(),
};

const createOrUpdateFileInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1),
  message: z.string().trim().min(1),
  content: z.string(),
  sha: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
};

const createOrUpdateFileOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  operation: createOrUpdateFileOperationSchema,
  commitSha: z.string().min(1),
  commitApiUrl: z.string().url(),
  commitHtmlUrl: z.string().url().nullable(),
  contentSha: z.string().min(1),
  contentApiUrl: z.string().url(),
  contentHtmlUrl: z.string().url().nullable(),
  downloadUrl: z.string().url().nullable(),
};

const listReleasesInputShape = {
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(10),
};

const listReleasesOutputShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  releases: z.array(releaseSummarySchema),
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
export type ListIssuesInput = InferShape<typeof listIssuesInputShape>;
export type ListIssuesOutput = InferShape<typeof listIssuesOutputShape>;
export type CreateIssueInput = InferShape<typeof createIssueInputShape>;
export type CreateIssueOutput = InferShape<typeof createIssueOutputShape>;
export type CommentOnIssueInput = InferShape<typeof commentOnIssueInputShape>;
export type CommentOnIssueOutput = InferShape<typeof commentOnIssueOutputShape>;
export type GetPullRequestInput = InferShape<typeof getPullRequestInputShape>;
export type GetPullRequestOutput = InferShape<typeof getPullRequestOutputShape>;
export type ListCommitsInput = InferShape<typeof listCommitsInputShape>;
export type ListCommitsOutput = InferShape<typeof listCommitsOutputShape>;
export type CreatePullRequestInput = InferShape<typeof createPullRequestInputShape>;
export type CreatePullRequestOutput = InferShape<typeof createPullRequestOutputShape>;
export type MergePullRequestInput = InferShape<typeof mergePullRequestInputShape>;
export type MergePullRequestOutput = InferShape<typeof mergePullRequestOutputShape>;
export type GetFileContentsInput = InferShape<typeof getFileContentsInputShape>;
export type GetFileContentsOutput = InferShape<typeof getFileContentsOutputShape>;
export type CreateOrUpdateFileInput = InferShape<typeof createOrUpdateFileInputShape>;
export type CreateOrUpdateFileOutput = InferShape<typeof createOrUpdateFileOutputShape>;
export type ListWorkflowRunsInput = InferShape<typeof listWorkflowRunsInputShape>;
export type ListWorkflowRunsOutput = InferShape<typeof listWorkflowRunsOutputShape>;
export type ListReleasesInput = InferShape<typeof listReleasesInputShape>;
export type ListReleasesOutput = InferShape<typeof listReleasesOutputShape>;
export type TriagePullRequestArgs = InferShape<typeof triagePullRequestArgsShape>;
export type GitHubServerConfig = z.infer<typeof gitHubConfigSchema>;

type RepositorySearchSort = (typeof REPOSITORY_SEARCH_SORT_VALUES)[number];
type SortOrder = (typeof SORT_ORDER_VALUES)[number];
type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS_VALUES)[number];
type IssueState = (typeof ISSUE_STATE_VALUES)[number];
type MergeMethod = (typeof MERGE_METHOD_VALUES)[number];
type CreateOrUpdateFileOperation = (typeof CREATE_OR_UPDATE_FILE_OPERATION_VALUES)[number];
type RequestParameterValue = boolean | number | readonly string[] | string | undefined;

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

interface GitHubIssueRecord {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  url: string;
  user: GitHubUser | null;
  labels: GitHubLabel[];
  comments: number;
  created_at: string;
  updated_at: string;
}

interface GitHubIssueCommentRecord {
  id: number;
  body: string;
  html_url: string;
  url: string;
  issue_url: string;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
}

interface GitHubCommitIdentity {
  name: string | null;
  date: string | null;
}

interface GitHubCommitDetails {
  message: string;
  author?: GitHubCommitIdentity | null;
  committer?: GitHubCommitIdentity | null;
}

interface GitHubCommitRecord {
  sha: string;
  commit: GitHubCommitDetails;
  author: GitHubUser | null;
  html_url: string;
  url: string;
}

interface GitHubPullRequestMergeRecord {
  sha: string;
  merged: boolean;
  message: string;
}

type GitHubRepositoryContentType = "file" | "dir" | "symlink" | "submodule";

interface GitHubRepositoryContentBaseRecord {
  type: GitHubRepositoryContentType;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string | null;
  git_url: string | null;
  download_url: string | null;
}

interface GitHubRepositoryFileContentRecord extends GitHubRepositoryContentBaseRecord {
  type: "file";
  encoding: string | null;
  content: string | null;
}

interface GitHubRepositoryNonFileContentRecord extends GitHubRepositoryContentBaseRecord {
  type: Exclude<GitHubRepositoryContentType, "file">;
}

interface GitHubFileWriteContentRecord {
  path: string;
  sha: string;
  url: string;
  html_url: string | null;
  download_url: string | null;
}

interface GitHubFileCommitRecord {
  sha: string;
  url: string;
  html_url: string | null;
}

interface GitHubReleaseRecord {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  url: string;
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

type ListIssuesParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  assignee?: string;
  labels?: string;
  state?: IssueState;
  page?: number;
  per_page?: number;
};

interface ListIssuesResponse {
  data: GitHubIssueRecord[];
}

type CreateIssueParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
};

interface CreateIssueResponse {
  data: GitHubIssueRecord;
}

type CreateIssueCommentParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
};

interface CreateIssueCommentResponse {
  data: GitHubIssueCommentRecord;
}

type ListCommitsParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  sha?: string;
  page?: number;
  per_page?: number;
};

interface ListCommitsResponse {
  data: GitHubCommitRecord[];
}

type CreatePullRequestParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
};

interface CreatePullRequestResponse {
  data: GitHubPullRequestRecord;
}

type MergePullRequestParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  pull_number: number;
  merge_method?: MergeMethod;
};

interface MergePullRequestResponse {
  data: GitHubPullRequestMergeRecord;
}

type GetFileContentsParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
};

interface GetFileContentsResponse {
  data: GitHubRepositoryFileContentRecord | GitHubRepositoryNonFileContentRecord | GitHubRepositoryContentBaseRecord[];
}

type CreateOrUpdateFileParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  sha?: string;
  branch?: string;
};

interface CreateOrUpdateFileResponse {
  status: number;
  data: {
    content: GitHubFileWriteContentRecord;
    commit: GitHubFileCommitRecord;
  };
}

type ListReleasesParams = Record<string, RequestParameterValue> & {
  owner: string;
  repo: string;
  page?: number;
  per_page?: number;
};

interface ListReleasesResponse {
  data: GitHubReleaseRecord[];
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
  issues: {
    listForRepo: (params: ListIssuesParams) => Promise<ListIssuesResponse>;
    create: (params: CreateIssueParams) => Promise<CreateIssueResponse>;
    createComment: (params: CreateIssueCommentParams) => Promise<CreateIssueCommentResponse>;
  };
  pulls: {
    get: (params: GetPullRequestParams) => Promise<GetPullRequestResponse>;
    create: (params: CreatePullRequestParams) => Promise<CreatePullRequestResponse>;
    merge: (params: MergePullRequestParams) => Promise<MergePullRequestResponse>;
  };
  actions: {
    listWorkflowRunsForRepo: (params: ListWorkflowRunsParams) => Promise<ListWorkflowRunsResponse>;
  };
  repos: {
    get: (params: GetRepositoryParams) => Promise<GetRepositoryResponse>;
    listCommits: (params: ListCommitsParams) => Promise<ListCommitsResponse>;
    getContent: (params: GetFileContentsParams) => Promise<GetFileContentsResponse>;
    createOrUpdateFileContents: (params: CreateOrUpdateFileParams) => Promise<CreateOrUpdateFileResponse>;
    listReleases: (params: ListReleasesParams) => Promise<ListReleasesResponse>;
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
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit/tree/main/servers/github",
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

function toGitHubLabelRecord(label: string | { name?: string | null; color?: string | null }): GitHubLabel {
  if (typeof label === "string") {
    return {
      name: label,
      color: null,
    };
  }

  if (typeof label.name === "string" && label.name.length > 0) {
    return {
      name: label.name,
      color: label.color ?? null,
    };
  }

  return {
    color: label.color ?? null,
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
    issues: {
      listForRepo: async (params) => {
        const response = await octokit.rest.issues.listForRepo(params);

        return {
          data: response.data
            .filter((issue) => !issue.pull_request)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              body: issue.body ?? null,
              html_url: issue.html_url,
              url: issue.url,
              user: issue.user ? toRequiredGitHubUser(issue.user, "listing issues") : null,
              labels: (issue.labels ?? []).map((label) => toGitHubLabelRecord(label)),
              comments: issue.comments,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
            })),
        };
      },
      create: async (params) => {
        const response = await octokit.rest.issues.create(params);

        return {
          data: {
            number: response.data.number,
            title: response.data.title,
            state: response.data.state,
            body: response.data.body ?? null,
            html_url: response.data.html_url,
            url: response.data.url,
            user: response.data.user ? toRequiredGitHubUser(response.data.user, "creating an issue") : null,
            labels: response.data.labels.map((label) => toGitHubLabelRecord(label)),
            comments: response.data.comments,
            created_at: response.data.created_at,
            updated_at: response.data.updated_at,
          },
        };
      },
      createComment: async (params) => {
        const response = await octokit.rest.issues.createComment(params);

        return {
          data: {
            id: response.data.id,
            body: response.data.body ?? params.body,
            html_url: response.data.html_url,
            url: response.data.url,
            issue_url: response.data.issue_url,
            user: response.data.user ? toRequiredGitHubUser(response.data.user, "creating an issue comment") : null,
            created_at: response.data.created_at,
            updated_at: response.data.updated_at,
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
            labels: response.data.labels.map((label) => toGitHubLabelRecord(label)),
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
      create: async (params) => {
        const response = await octokit.rest.pulls.create(params);

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
            user: response.data.user ? toRequiredGitHubUser(response.data.user, "creating a pull request") : null,
            labels: response.data.labels.map((label) => toGitHubLabelRecord(label)),
            requested_reviewers: (response.data.requested_reviewers ?? []).map((reviewer) =>
              toRequiredGitHubUser(reviewer, "creating a pull request"),
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
      merge: async (params) => {
        const response = await octokit.rest.pulls.merge(params);

        return {
          data: {
            sha: response.data.sha,
            merged: response.data.merged,
            message: response.data.message,
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
      listCommits: async (params) => {
        const response = await octokit.rest.repos.listCommits(params);

        return {
          data: response.data.map((commit) => ({
            sha: commit.sha,
            commit: {
              message: commit.commit.message,
              author: commit.commit.author
                ? {
                    name: commit.commit.author.name ?? null,
                    date: commit.commit.author.date ?? null,
                  }
                : null,
              committer: commit.commit.committer
                ? {
                    name: commit.commit.committer.name ?? null,
                    date: commit.commit.committer.date ?? null,
                  }
                : null,
            },
            author:
              commit.author &&
              "login" in commit.author &&
              "html_url" in commit.author &&
              "url" in commit.author &&
              typeof commit.author.login === "string" &&
              typeof commit.author.html_url === "string" &&
              typeof commit.author.url === "string"
                ? toRequiredGitHubUser(commit.author as MinimalGitHubUser, "listing commits")
                : null,
            html_url: commit.html_url,
            url: commit.url,
          })),
        };
      },
      getContent: async (params) => {
        const response = await octokit.rest.repos.getContent(params);

        if (Array.isArray(response.data)) {
          return {
            data: response.data.map((entry) => ({
              type: entry.type as GitHubRepositoryContentType,
              path: entry.path,
              sha: entry.sha,
              size: entry.size,
              url: entry.url,
              html_url: entry.html_url ?? null,
              git_url: entry.git_url ?? null,
              download_url: entry.download_url ?? null,
            })),
          };
        }

        return {
          data: {
            type: response.data.type as GitHubRepositoryContentType,
            path: response.data.path,
            sha: response.data.sha,
            size: response.data.size,
            url: response.data.url,
            html_url: response.data.html_url ?? null,
            git_url: response.data.git_url ?? null,
            download_url: response.data.download_url ?? null,
            encoding: "encoding" in response.data ? response.data.encoding ?? null : null,
            content: "content" in response.data ? response.data.content ?? "" : null,
          },
        };
      },
      createOrUpdateFileContents: async (params) => {
        const response = await octokit.rest.repos.createOrUpdateFileContents(params);

        if (!response.data.content) {
          throw new ExternalServiceError("GitHub did not return file content metadata while writing a file.", {
            exposeToClient: false,
          });
        }

        if (
          !response.data.content.path ||
          !response.data.content.sha ||
          !response.data.content.url ||
          !response.data.commit.sha ||
          !response.data.commit.url
        ) {
          throw new ExternalServiceError("GitHub did not return complete file metadata while writing a file.", {
            exposeToClient: false,
          });
        }

        return {
          status: response.status,
          data: {
            content: {
              path: response.data.content.path,
              sha: response.data.content.sha,
              url: response.data.content.url,
              html_url: response.data.content.html_url ?? null,
              download_url: response.data.content.download_url ?? null,
            },
            commit: {
              sha: response.data.commit.sha,
              url: response.data.commit.url,
              html_url: response.data.commit.html_url ?? null,
            },
          },
        };
      },
      listReleases: async (params) => {
        const response = await octokit.rest.repos.listReleases(params);

        return {
          data: response.data.map((release) => ({
            id: release.id,
            tag_name: release.tag_name,
            name: release.name ?? null,
            body: release.body ?? null,
            draft: release.draft,
            prerelease: release.prerelease,
            published_at: release.published_at ?? null,
            html_url: release.html_url,
            url: release.url,
          })),
        };
      },
    },
  };
}

type OwnerSummary = z.infer<typeof ownerSummarySchema>;
type LabelSummary = z.infer<typeof labelSummarySchema>;
type RepositorySummary = z.infer<typeof repositorySummarySchema>;
type IssueSummary = z.infer<typeof issueSummarySchema>;
type CommitSummary = z.infer<typeof commitSummarySchema>;
type ReleaseSummary = z.infer<typeof releaseSummarySchema>;
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

function toIssueSummary(record: GitHubIssueRecord): IssueSummary {
  return {
    number: record.number,
    title: record.title,
    state: record.state,
    author: toNullableOwnerSummary(record.user),
    labels: record.labels.map((label) => toLabelSummary(label)),
    comments: record.comments,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toIssueOutput(record: GitHubIssueRecord, owner: string, repo: string): CreateIssueOutput {
  return {
    owner,
    repo,
    issueNumber: record.number,
    title: record.title,
    state: record.state,
    body: record.body,
    author: toNullableOwnerSummary(record.user),
    labels: record.labels.map((label) => toLabelSummary(label)),
    comments: record.comments,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toCommentOnIssueOutput(
  owner: string,
  repo: string,
  issueNumber: number,
  record: GitHubIssueCommentRecord,
): CommentOnIssueOutput {
  return {
    owner,
    repo,
    issueNumber,
    commentId: record.id,
    body: record.body,
    author: toNullableOwnerSummary(record.user),
    htmlUrl: record.html_url,
    apiUrl: record.url,
    issueApiUrl: record.issue_url,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function toCommitSummary(record: GitHubCommitRecord): CommitSummary {
  return {
    sha: record.sha,
    message: record.commit.message,
    author: toNullableOwnerSummary(record.author),
    authorName: record.commit.author?.name ?? record.commit.committer?.name ?? null,
    date: record.commit.author?.date ?? record.commit.committer?.date ?? null,
    htmlUrl: record.html_url,
    apiUrl: record.url,
  };
}

function toPullRequestOutput(owner: string, repo: string, record: GitHubPullRequestRecord): GetPullRequestOutput {
  return {
    owner,
    repo,
    pullNumber: record.number,
    title: record.title,
    state: record.state,
    body: record.body,
    isDraft: record.draft ?? false,
    isMerged: record.merged,
    mergeable: record.mergeable,
    mergeableState: record.mergeable_state ?? null,
    htmlUrl: record.html_url,
    apiUrl: record.url,
    author: toNullableOwnerSummary(record.user),
    labels: record.labels.map((label) => toLabelSummary(label)),
    requestedReviewers: record.requested_reviewers.map((reviewer) => toOwnerSummary(reviewer)),
    comments: record.comments,
    reviewComments: record.review_comments,
    commits: record.commits,
    additions: record.additions,
    deletions: record.deletions,
    changedFiles: record.changed_files,
    headRef: record.head.ref,
    headSha: record.head.sha,
    baseRef: record.base.ref,
    baseSha: record.base.sha,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    mergedAt: record.merged_at,
  };
}

function requireGitHubFileContent(
  data: GetFileContentsResponse["data"],
  requestedPath: string,
): GitHubRepositoryFileContentRecord {
  if (Array.isArray(data)) {
    throw new ValidationError(`Path "${requestedPath}" resolves to a directory. get_file_contents only supports files.`);
  }

  if (data.type !== GITHUB_FILE_CONTENT_TYPE) {
    throw new ValidationError(
      `Path "${requestedPath}" does not resolve to a file. GitHub returned type "${data.type}".`,
    );
  }

  return data;
}

function decodeGitHubFileContent(record: GitHubRepositoryFileContentRecord): string {
  if (record.encoding?.toLowerCase() !== GITHUB_CONTENTS_BASE64_ENCODING) {
    throw new ExternalServiceError(
      `GitHub returned encoding "${record.encoding ?? "unknown"}" for "${record.path}". get_file_contents only supports base64 payloads.`,
    );
  }

  if (record.content === null) {
    throw new ExternalServiceError(`GitHub did not include file contents for "${record.path}".`);
  }

  return Buffer.from(record.content.replace(/\s+/g, ""), GITHUB_CONTENTS_BASE64_ENCODING).toString("utf8");
}

function toFileContentsOutput(
  repository: { owner: string; repo: string },
  ref: string | undefined,
  record: GitHubRepositoryFileContentRecord,
): GetFileContentsOutput {
  return {
    owner: repository.owner,
    repo: repository.repo,
    path: record.path,
    ref: ref ?? null,
    sha: record.sha,
    size: record.size,
    encoding: record.encoding ?? GITHUB_CONTENTS_BASE64_ENCODING,
    content: decodeGitHubFileContent(record),
    htmlUrl: record.html_url,
    downloadUrl: record.download_url,
    apiUrl: record.url,
    gitUrl: record.git_url,
  };
}

function encodeGitHubFileContent(content: string): string {
  return Buffer.from(content, "utf8").toString(GITHUB_CONTENTS_BASE64_ENCODING);
}

function toCreateOrUpdateFileOperation(status: number): CreateOrUpdateFileOperation {
  return status === 201 ? "created" : "updated";
}

function toCreateOrUpdateFileOutput(
  repository: { owner: string; repo: string },
  response: CreateOrUpdateFileResponse,
): CreateOrUpdateFileOutput {
  return {
    owner: repository.owner,
    repo: repository.repo,
    path: response.data.content.path,
    operation: toCreateOrUpdateFileOperation(response.status),
    commitSha: response.data.commit.sha,
    commitApiUrl: response.data.commit.url,
    commitHtmlUrl: response.data.commit.html_url ?? null,
    contentSha: response.data.content.sha,
    contentApiUrl: response.data.content.url,
    contentHtmlUrl: response.data.content.html_url ?? null,
    downloadUrl: response.data.content.download_url ?? null,
  };
}

function toMergePullRequestOutput(
  repository: { owner: string; repo: string },
  pullRequest: GitHubPullRequestRecord,
  mergeResult: GitHubPullRequestMergeRecord,
  mergeMethod: MergeMethod,
): MergePullRequestOutput {
  return {
    owner: repository.owner,
    repo: repository.repo,
    pullNumber: pullRequest.number,
    title: pullRequest.title,
    mergeMethod,
    merged: mergeResult.merged,
    message: mergeResult.message,
    sha: mergeResult.sha,
  };
}

function toReleaseSummary(record: GitHubReleaseRecord): ReleaseSummary {
  return {
    id: record.id,
    tagName: record.tag_name,
    name: record.name,
    body: record.body,
    isDraft: record.draft,
    isPrerelease: record.prerelease,
    publishedAt: record.published_at,
    htmlUrl: record.html_url,
    apiUrl: record.url,
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

function renderIssues(output: ListIssuesOutput): string {
  const filters = [
    `state=${output.stateFilter}`,
    output.assigneeFilter ? `assignee=${output.assigneeFilter}` : null,
    output.labelFilter.length > 0 ? `labels=${output.labelFilter.join(", ")}` : null,
  ].filter((value): value is string => value !== null);

  const lines = output.issues.map((issue) => {
    const author = issue.author?.login ?? "unknown-author";
    const labels = issue.labels.length > 0 ? issue.labels.map((label) => label.name).join(", ") : "none";
    return `- #${issue.number} ${issue.title} [${issue.state}] by ${author} • labels: ${labels} • comments: ${issue.comments}`;
  });

  const header = `Found ${output.issueCount} issues for ${output.owner}/${output.repo}${filters.length > 0 ? ` (${filters.join(" • ")})` : ""}.`;
  return [header, ...lines].join("\n");
}

function renderCreatedIssue(output: CreateIssueOutput): string {
  const labels = output.labels.length > 0 ? output.labels.map((label) => label.name).join(", ") : "none";

  return [
    `Created issue #${output.issueNumber} in ${output.owner}/${output.repo}: ${output.title}`,
    `State: ${output.state}`,
    `Labels: ${labels}`,
    `URL: ${output.htmlUrl}`,
  ].join("\n");
}

function renderCommentOnIssue(output: CommentOnIssueOutput): string {
  return [
    `Added comment to issue #${output.issueNumber} in ${output.owner}/${output.repo}.`,
    `Comment ID: ${output.commentId}`,
    `Author: ${output.author?.login ?? "unknown-author"}`,
    `Created: ${output.createdAt}`,
    `Comment URL: ${output.htmlUrl}`,
    "",
    output.body,
  ].join("\n");
}

function renderCommits(output: ListCommitsOutput): string {
  const scope = output.ref ? ` at ${output.ref}` : "";
  const lines = output.commits.map((commit) => {
    const headline = commit.message.split(/\r?\n/u)[0]?.trim() || commit.message;
    return `- ${commit.sha.slice(0, 7)} ${headline} — ${commit.author?.login ?? commit.authorName ?? "unknown author"} (${commit.date ?? "unknown date"})`;
  });

  return [`Listed ${output.commits.length} commits for ${output.owner}/${output.repo}${scope}.`, ...lines].join("\n");
}

function renderCreatedPullRequest(output: CreatePullRequestOutput): string {
  return [
    `Created pull request #${output.pullNumber} in ${output.owner}/${output.repo}: ${output.title}`,
    `State: ${output.state}${output.isDraft ? " (draft)" : ""}`,
    `Branches: ${output.headRef} -> ${output.baseRef}`,
    `URL: ${output.htmlUrl}`,
  ].join("\n");
}

function renderMergePullRequest(output: MergePullRequestOutput): string {
  const headline = output.merged
    ? `Merged pull request #${output.pullNumber} in ${output.owner}/${output.repo}: ${output.title}`
    : `GitHub did not merge pull request #${output.pullNumber} in ${output.owner}/${output.repo}: ${output.title}`;

  return [headline, `Method: ${output.mergeMethod}`, `SHA: ${output.sha}`, `Message: ${output.message}`].join("\n");
}

function renderFileContents(output: GetFileContentsOutput): string {
  const lines = [
    `File: ${output.owner}/${output.repo}:${output.path}${output.ref ? ` @ ${output.ref}` : ""}`,
    `SHA: ${output.sha}`,
    `Size: ${output.size} bytes`,
    `Encoding: ${output.encoding}`,
    `API URL: ${output.apiUrl}`,
  ];
  if (output.htmlUrl) lines.push(`HTML URL: ${output.htmlUrl}`);
  if (output.downloadUrl) lines.push(`Download URL: ${output.downloadUrl}`);
  if (output.gitUrl) lines.push(`Git URL: ${output.gitUrl}`);
  lines.push("", output.content.length > 0 ? output.content : "[empty file]");
  return lines.join("\n");
}

function renderCreateOrUpdateFile(output: CreateOrUpdateFileOutput): string {
  const action = output.operation === "created" ? "Created" : "Updated";
  const lines = [
    `${action} ${output.owner}/${output.repo}:${output.path}`,
    `Commit: ${output.commitSha}`,
    `Commit URL: ${output.commitHtmlUrl ?? output.commitApiUrl}`,
    `Content URL: ${output.contentHtmlUrl ?? output.contentApiUrl}`,
  ];

  if (output.downloadUrl !== null) {
    lines.push(`Download URL: ${output.downloadUrl}`);
  }

  return lines.join("\n");
}

function renderReleases(output: ListReleasesOutput): string {
  const lines = output.releases.map((release) => {
    const nameSuffix = release.name ? ` — ${release.name}` : "";
    const statusParts: string[] = [];

    if (release.isDraft) statusParts.push("draft");
    if (release.isPrerelease) statusParts.push("prerelease");
    statusParts.push(release.publishedAt ? `published ${release.publishedAt}` : "unpublished");

    return `- ${release.tagName}${nameSuffix} [${statusParts.join(" • ")}]`;
  });

  return [`Found ${output.releases.length} releases for ${output.owner}/${output.repo}.`, ...lines].join("\n");
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
    this.registerListIssuesTool();
    this.registerCreateIssueTool();
    this.registerCommentOnIssueTool();
    this.registerGetFileContentsTool();
    this.registerGetPullRequestTool();
    this.registerListCommitsTool();
    this.registerCreatePullRequestTool();
    this.registerMergePullRequestTool();
    this.registerCreateOrUpdateFileTool();
    this.registerListReleasesTool();
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

  private registerListIssuesTool(): void {
    this.registerTool(
      defineTool({
        name: "list_issues",
        title: "List issues",
        description: "List repository issues with optional state, label, and assignee filters.",
        inputSchema: listIssuesInputShape,
        outputSchema: listIssuesOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Listing issues for ${repository.owner}/${repository.repo}`);

          const params: ListIssuesParams = {
            owner: repository.owner,
            repo: repository.repo,
            state: input.state,
            page: input.page,
            per_page: input.perPage,
          };

          if (input.assignee !== undefined) {
            params.assignee = input.assignee;
          }

          if (input.labels.length > 0) {
            params.labels = input.labels.join(",");
          }

          const response = await this.withGitHubApi("listing issues", () => this.client.issues.listForRepo(params));
          const issues = response.data.map((issue) => toIssueSummary(issue));

          return {
            owner: repository.owner,
            repo: repository.repo,
            stateFilter: input.state,
            assigneeFilter: input.assignee ?? null,
            labelFilter: [...input.labels],
            page: input.page,
            perPage: input.perPage,
            issueCount: issues.length,
            issues,
          };
        },
        renderText: renderIssues,
      }),
    );
  }

  private registerCreateIssueTool(): void {
    this.registerTool(
      defineTool({
        name: "create_issue",
        title: "Create an issue",
        description: "Create a new GitHub issue with title, body, and optional labels.",
        inputSchema: createIssueInputShape,
        outputSchema: createIssueOutputShape,
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Creating issue "${input.title}" in ${repository.owner}/${repository.repo}`);

          const params: CreateIssueParams = {
            owner: repository.owner,
            repo: repository.repo,
            title: input.title,
            body: input.body,
          };

          if (input.labels.length > 0) {
            params.labels = input.labels;
          }

          const response = await this.withGitHubApi("creating an issue", () => this.client.issues.create(params));

          return toIssueOutput(response.data, repository.owner, repository.repo);
        },
        renderText: renderCreatedIssue,
      }),
    );
  }

  private registerCommentOnIssueTool(): void {
    this.registerTool(
      defineTool({
        name: "comment_on_issue",
        title: "Comment on an issue",
        description: "Add a comment to an existing GitHub issue using configured repo defaults when available.",
        inputSchema: commentOnIssueInputShape,
        outputSchema: commentOnIssueOutputShape,
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Adding comment to issue #${input.issueNumber} for ${repository.owner}/${repository.repo}`);

          const response = await this.withGitHubApi("commenting on an issue", () =>
            this.client.issues.createComment({
              owner: repository.owner,
              repo: repository.repo,
              issue_number: input.issueNumber,
              body: input.body,
            }),
          );

          return toCommentOnIssueOutput(repository.owner, repository.repo, input.issueNumber, response.data);
        },
        renderText: renderCommentOnIssue,
      }),
    );
  }

  private registerGetFileContentsTool(): void {
    this.registerTool(
      defineTool({
        name: "get_file_contents",
        title: "Get file contents",
        description: "Read a file from a GitHub repository at an optional ref and return decoded contents with file metadata.",
        inputSchema: getFileContentsInputShape,
        outputSchema: getFileContentsOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Loading file contents for ${repository.owner}/${repository.repo}:${input.path}`);

          const params: GetFileContentsParams = {
            owner: repository.owner,
            repo: repository.repo,
            path: input.path,
          };

          if (input.ref !== undefined) {
            params.ref = input.ref;
          }

          const response = await this.withGitHubApi("loading file contents", () => this.client.repos.getContent(params));
          const record = requireGitHubFileContent(response.data, input.path);
          return toFileContentsOutput(repository, input.ref, record);
        },
        renderText: renderFileContents,
      }),
    );
  }

  private registerListCommitsTool(): void {
    this.registerTool(
      defineTool({
        name: "list_commits",
        title: "List commits",
        description: "List recent commits for a repository with an optional branch or commitish selector.",
        inputSchema: listCommitsInputShape,
        outputSchema: listCommitsOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log(
            "info",
            `Listing commits for ${repository.owner}/${repository.repo}${input.sha ? ` at ${input.sha}` : ""}`,
          );

          const params: ListCommitsParams = {
            owner: repository.owner,
            repo: repository.repo,
            page: input.page,
            per_page: input.perPage,
          };

          if (input.sha !== undefined) {
            params.sha = input.sha;
          }

          const response = await this.withGitHubApi("listing commits", () => this.client.repos.listCommits(params));

          return {
            owner: repository.owner,
            repo: repository.repo,
            ref: input.sha ?? null,
            page: input.page,
            perPage: input.perPage,
            commits: response.data.map((commit) => toCommitSummary(commit)),
          };
        },
        renderText: renderCommits,
      }),
    );
  }

  private registerCreatePullRequestTool(): void {
    this.registerTool(
      defineTool({
        name: "create_pull_request",
        title: "Create a pull request",
        description: "Create a pull request from a head branch to a base branch in the target repository.",
        inputSchema: createPullRequestInputShape,
        outputSchema: createPullRequestOutputShape,
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);

          if (input.head === input.base) {
            throw new ValidationError("Head and base branches must be different when creating a pull request.");
          }

          await context.log(
            "info",
            `Creating pull request from ${input.head} to ${input.base} for ${repository.owner}/${repository.repo}`,
          );

          const params: CreatePullRequestParams = {
            owner: repository.owner,
            repo: repository.repo,
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
          };

          if (input.draft) {
            params.draft = true;
          }

          const response = await this.withGitHubApi("creating a pull request", () => this.client.pulls.create(params));

          return toPullRequestOutput(repository.owner, repository.repo, response.data);
        },
        renderText: renderCreatedPullRequest,
      }),
    );
  }

  private registerMergePullRequestTool(): void {
    this.registerTool(
      defineTool({
        name: "merge_pull_request",
        title: "Merge a pull request",
        description: "Merge a GitHub pull request using the merge, squash, or rebase strategy.",
        inputSchema: mergePullRequestInputShape,
        outputSchema: mergePullRequestOutputShape,
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log(
            "info",
            `Merging pull request #${input.pullNumber} for ${repository.owner}/${repository.repo} with ${input.mergeMethod}`,
          );

          const pullRequest = await this.withGitHubApi("loading a pull request before merging", () =>
            this.client.pulls.get({
              owner: repository.owner,
              repo: repository.repo,
              pull_number: input.pullNumber,
            }),
          );

          const mergeResult = await this.withGitHubApi("merging a pull request", () =>
            this.client.pulls.merge({
              owner: repository.owner,
              repo: repository.repo,
              pull_number: input.pullNumber,
              merge_method: input.mergeMethod,
            }),
          );

          return toMergePullRequestOutput(repository, pullRequest.data, mergeResult.data, input.mergeMethod);
        },
        renderText: renderMergePullRequest,
      }),
    );
  }

  private registerCreateOrUpdateFileTool(): void {
    this.registerTool(
      defineTool({
        name: "create_or_update_file",
        title: "Create or update a repository file",
        description: "Create a new file or replace an existing file in a GitHub repository with a commit.",
        inputSchema: createOrUpdateFileInputShape,
        outputSchema: createOrUpdateFileOutputShape,
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Creating or updating ${input.path} in ${repository.owner}/${repository.repo}`);

          const params: CreateOrUpdateFileParams = {
            owner: repository.owner,
            repo: repository.repo,
            path: input.path,
            message: input.message,
            content: encodeGitHubFileContent(input.content),
          };

          if (input.sha !== undefined) {
            params.sha = input.sha;
          }

          if (input.branch !== undefined) {
            params.branch = input.branch;
          }

          const response = await this.withGitHubApi("creating or updating a repository file", () =>
            this.client.repos.createOrUpdateFileContents(params),
          );

          return toCreateOrUpdateFileOutput(repository, response);
        },
        renderText: renderCreateOrUpdateFile,
      }),
    );
  }

  private registerListReleasesTool(): void {
    this.registerTool(
      defineTool({
        name: "list_releases",
        title: "List releases",
        description: "List repository releases with tag, draft, prerelease, publication, URL, and body details.",
        inputSchema: listReleasesInputShape,
        outputSchema: listReleasesOutputShape,
        annotations: {
          readOnlyHint: true,
        },
        handler: async (input, context) => {
          const repository = this.resolveRepositoryTarget(input.owner, input.repo);
          await context.log("info", `Listing releases for ${repository.owner}/${repository.repo}`);

          const response = await this.withGitHubApi("listing releases", () =>
            this.client.repos.listReleases({
              owner: repository.owner,
              repo: repository.repo,
              page: input.page,
              per_page: input.perPage,
            }),
          );

          return {
            owner: repository.owner,
            repo: repository.repo,
            page: input.page,
            perPage: input.perPage,
            releases: response.data.map((release) => toReleaseSummary(release)),
          };
        },
        renderText: renderReleases,
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
