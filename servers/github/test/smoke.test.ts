import { describe, expect, it, vi } from "vitest";

import {
  GitHubServer,
  createServer,
  metadata,
  serverCard,
  type GetPullRequestOutput,
  type GitHubApiClient,
  type ListWorkflowRunsOutput,
  type SearchRepositoriesOutput,
} from "../src/index.js";

function createFakeClient() {
  const searchRepos = vi.fn(async () => ({
    data: {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          owner: {
            login: "octo-org",
            html_url: "https://github.com/octo-org",
            url: "https://api.github.com/users/octo-org",
          },
          name: "hello-world",
          full_name: "octo-org/hello-world",
          description: "A sample repository for smoke tests.",
          private: false,
          archived: false,
          fork: false,
          language: "TypeScript",
          stargazers_count: 42,
          forks_count: 5,
          open_issues_count: 2,
          topics: ["mcp", "github"],
          default_branch: "main",
          html_url: "https://github.com/octo-org/hello-world",
          url: "https://api.github.com/repos/octo-org/hello-world",
          updated_at: "2024-01-02T00:00:00Z",
          pushed_at: "2024-01-03T00:00:00Z",
        },
      ],
    },
  }));

  const getPullRequest = vi.fn(async () => ({
    data: {
      number: 42,
      title: "Improve pull request triage",
      state: "open",
      body: "This improves automation coverage.",
      draft: false,
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      html_url: "https://github.com/octo-org/hello-world/pull/42",
      url: "https://api.github.com/repos/octo-org/hello-world/pulls/42",
      user: {
        login: "contributor",
        html_url: "https://github.com/contributor",
        url: "https://api.github.com/users/contributor",
      },
      labels: [{ name: "ready-for-review", color: "0e8a16" }],
      requested_reviewers: [
        {
          login: "maintainer",
          html_url: "https://github.com/maintainer",
          url: "https://api.github.com/users/maintainer",
        },
      ],
      comments: 1,
      review_comments: 2,
      commits: 3,
      additions: 12,
      deletions: 4,
      changed_files: 2,
      head: {
        ref: "feature/triage",
        sha: "abc123",
      },
      base: {
        ref: "main",
        sha: "def456",
      },
      created_at: "2024-01-04T00:00:00Z",
      updated_at: "2024-01-05T00:00:00Z",
      merged_at: null,
    },
  }));

  const listWorkflowRunsForRepo = vi.fn(async () => ({
    data: {
      total_count: 1,
      workflow_runs: [
        {
          id: 1001,
          workflow_id: 3001,
          run_number: 57,
          name: "CI",
          display_title: "CI",
          event: "pull_request",
          head_branch: "feature/triage",
          head_sha: "abc123",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/octo-org/hello-world/actions/runs/1001",
          url: "https://api.github.com/repos/octo-org/hello-world/actions/runs/1001",
          actor: {
            login: "github-actions[bot]",
            html_url: "https://github.com/apps/github-actions",
            url: "https://api.github.com/users/github-actions%5Bbot%5D",
          },
          head_commit: {
            message: "Improve pull request triage",
          },
          created_at: "2024-01-05T00:00:00Z",
          updated_at: "2024-01-05T00:10:00Z",
        },
      ],
    },
  }));

  const getRepository = vi.fn(async () => ({
    data: {
      owner: {
        login: "octo-org",
        html_url: "https://github.com/octo-org",
        url: "https://api.github.com/users/octo-org",
      },
      name: "hello-world",
      full_name: "octo-org/hello-world",
      description: "A sample repository for smoke tests.",
      visibility: "public",
      private: false,
      archived: false,
      disabled: false,
      fork: false,
      language: "TypeScript",
      default_branch: "main",
      topics: ["mcp", "github"],
      stargazers_count: 42,
      watchers_count: 42,
      forks_count: 5,
      open_issues_count: 2,
      html_url: "https://github.com/octo-org/hello-world",
      url: "https://api.github.com/repos/octo-org/hello-world",
      clone_url: "https://github.com/octo-org/hello-world.git",
      ssh_url: "git@github.com:octo-org/hello-world.git",
      homepage: null,
      has_issues: true,
      has_projects: false,
      has_wiki: true,
      has_discussions: true,
      license: {
        spdx_id: "MIT",
        name: "MIT License",
      },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      pushed_at: "2024-01-03T00:00:00Z",
    },
  }));

  const client: GitHubApiClient = {
    search: {
      repos: searchRepos,
    },
    pulls: {
      get: getPullRequest,
    },
    actions: {
      listWorkflowRunsForRepo,
    },
    repos: {
      get: getRepository,
    },
  };

  return {
    client,
    searchRepos,
    getPullRequest,
    listWorkflowRunsForRepo,
    getRepository,
  };
}

describe("GitHubServer", () => {
  it("registers the expected tools, resources, and prompts", () => {
    const { client } = createFakeClient();
    const server = new GitHubServer({
      client,
      config: {
        token: "test-token",
        defaultOwner: "octo-org",
        defaultRepo: "hello-world",
      },
    });

    expect(server.getToolNames()).toEqual(metadata.toolNames);
    expect(server.getResourceNames()).toEqual(metadata.resourceNames);
    expect(server.getPromptNames()).toEqual(metadata.promptNames);
    expect(serverCard.tools).toEqual(metadata.toolNames);
    expect(serverCard.resources).toEqual(metadata.resourceNames);
    expect(serverCard.prompts).toEqual(metadata.promptNames);
  });

  it("searches repositories through the injected client", async () => {
    const { client, searchRepos } = createFakeClient();
    const server = new GitHubServer({
      client,
      config: {
        token: "test-token",
        defaultOwner: "octo-org",
        defaultRepo: "hello-world",
      },
    });

    const result = await server.invokeTool<SearchRepositoriesOutput>("search_repositories", {
      query: "mcp toolkit",
    });

    expect(searchRepos).toHaveBeenCalledWith({
      q: "mcp toolkit",
      page: 1,
      per_page: 10,
    });
    expect(result).toMatchObject({
      query: "mcp toolkit",
      totalCount: 1,
      repositories: [
        {
          fullName: "octo-org/hello-world",
          stars: 42,
        },
      ],
    });
  });

  it("uses configured repo defaults for pull request and workflow lookups", async () => {
    const { client, getPullRequest, listWorkflowRunsForRepo } = createFakeClient();
    const server = new GitHubServer({
      client,
      config: {
        token: "test-token",
        defaultOwner: "octo-org",
        defaultRepo: "hello-world",
      },
    });

    const pullRequest = await server.invokeTool<GetPullRequestOutput>("get_pull_request", {
      pullNumber: 42,
    });
    const workflowRuns = await server.invokeTool<ListWorkflowRunsOutput>("list_workflow_runs", {
      branch: "feature/triage",
      perPage: 5,
    });

    expect(getPullRequest).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "hello-world",
      pull_number: 42,
    });
    expect(listWorkflowRunsForRepo).toHaveBeenCalledWith({
      owner: "octo-org",
      repo: "hello-world",
      branch: "feature/triage",
      page: 1,
      per_page: 5,
      exclude_pull_requests: false,
    });
    expect(pullRequest).toMatchObject({
      owner: "octo-org",
      repo: "hello-world",
      pullNumber: 42,
      mergeableState: "clean",
    });
    expect(workflowRuns).toMatchObject({
      owner: "octo-org",
      repo: "hello-world",
      runs: [
        {
          displayTitle: "CI",
          conclusion: "success",
        },
      ],
    });
  });

  it("requires explicit repository context when defaults are unavailable", async () => {
    const { client } = createFakeClient();
    const server = new GitHubServer({
      client,
      config: {
        token: "test-token",
      },
    });

    await expect(server.invokeTool<unknown>("get_pull_request", { pullNumber: 42 })).rejects.toThrow(
      /Repository owner and repo are required/,
    );
  });

  it("creates a server from env-backed configuration while still allowing fake clients", () => {
    const { client } = createFakeClient();
    const server = createServer({
      client,
      envSource: {
        GITHUB_TOKEN: "test-token",
        GITHUB_DEFAULT_OWNER: "octo-org",
        GITHUB_DEFAULT_REPO: "hello-world",
      },
    });

    expect(server).toBeInstanceOf(GitHubServer);
  });
});
