import { describe, expect, it } from "vitest";

import {
  JiraServer,
  createServer,
  metadata,
  serverCard,
  type JiraClient,
  type JiraEnvironment,
  type JiraSearchRequest,
} from "../src/index.js";

const testEnvironment: JiraEnvironment = {
  baseUrl: "https://example.atlassian.net",
  email: "bot@example.com",
  apiToken: "test-token",
  defaultProjectKey: "OPS",
};

function createIssue(statusName: string) {
  return {
    id: "10001",
    key: "OPS-42",
    summary: "API latency spike",
    status: {
      name: statusName,
    },
    assignee: {
      displayName: "On Call Engineer",
    },
    reporter: {
      displayName: "Incident Bot",
    },
    priority: {
      name: "Highest",
    },
    issueType: {
      name: "Incident",
    },
    project: {
      key: "OPS",
      name: "Operations",
    },
    created: "2025-01-01T00:00:00.000+0000",
    updated: "2025-01-01T01:00:00.000+0000",
    url: "https://example.atlassian.net/browse/OPS-42",
    description: "95th percentile latency exceeded the SLO.",
    labels: ["incident", "api"],
    comments: [
      {
        id: "20001",
        body: "Investigating database saturation.",
        author: {
          displayName: "On Call Engineer",
        },
      },
    ],
  };
}

class FakeJiraClient implements JiraClient {
  public readonly searchRequests: JiraSearchRequest[] = [];
  public readonly transitionCalls: Array<{
    issueKey: string;
    transitionId: string;
    comment?: string;
  }> = [];

  private readonly currentIssue = createIssue("In Progress");

  public async searchIssues(request: JiraSearchRequest) {
    this.searchRequests.push(request);
    return {
      startAt: request.startAt,
      maxResults: request.maxResults,
      total: 1,
      issues: [createIssue("In Progress")],
    };
  }

  public async getIssue() {
    return {
      ...this.currentIssue,
    };
  }

  public async getTransitions() {
    return [
      {
        id: "31",
        name: "Done",
        toStatus: {
          name: "Done",
        },
      },
      {
        id: "21",
        name: "In Progress",
        toStatus: {
          name: "In Progress",
        },
      },
    ];
  }

  public async transitionIssue(issueKey: string, transitionId: string, comment?: string) {
    const transitionCall: {
      issueKey: string;
      transitionId: string;
      comment?: string;
    } = {
      issueKey,
      transitionId,
    };

    if (comment !== undefined) {
      transitionCall.comment = comment;
    }

    this.transitionCalls.push(transitionCall);
    this.currentIssue.status = {
      name: transitionId === "31" ? "Done" : "In Progress",
    };
  }

  public async getProject(projectKey: string) {
    return {
      key: projectKey,
      name: "Operations",
      description: "Core operational incidents and follow-up work.",
      projectTypeKey: "software",
      lead: {
        displayName: "Operations Lead",
      },
      apiUrl: "https://example.atlassian.net/rest/api/3/project/OPS",
    };
  }
}

describe("jira server smoke tests", () => {
  it("registers metadata and discovery card names that match the server", () => {
    const server = createServer({
      environment: testEnvironment,
      client: new FakeJiraClient(),
    });

    expect(server.getToolNames()).toEqual([...metadata.toolNames]);
    expect(server.getResourceNames()).toEqual([...metadata.resourceNames]);
    expect(server.getPromptNames()).toEqual([...metadata.promptNames]);
    expect(serverCard.tools).toEqual([...metadata.toolNames]);
    expect(serverCard.resources).toEqual([...metadata.resourceNames]);
    expect(serverCard.prompts).toEqual([...metadata.promptNames]);
  });

  it("searches issues using the injected fake client and default project key", async () => {
    const client = new FakeJiraClient();
    const server = new JiraServer({
      environment: testEnvironment,
      client,
    });

    const result = await server.invokeTool("search_issues", {
      text: "latency spike",
      maxResults: 5,
    });

    expect(result).toMatchObject({
      total: 1,
      issues: [
        {
          key: "OPS-42",
          summary: "API latency spike",
        },
      ],
    });
    expect(client.searchRequests).toHaveLength(1);
    expect(client.searchRequests[0]?.jql).toContain('project = "OPS"');
    expect(client.searchRequests[0]?.jql).toContain('text ~ "latency spike"');
  });

  it("transitions an issue by name and returns the updated issue", async () => {
    const client = new FakeJiraClient();
    const server = createServer({
      environment: testEnvironment,
      client,
    });

    const result = await server.invokeTool("transition_issue", {
      issueKey: "OPS-42",
      transitionName: "Done",
      comment: "Mitigation deployed and metrics recovered.",
    });

    expect(result).toMatchObject({
      issueKey: "OPS-42",
      transition: {
        id: "31",
        name: "Done",
      },
      commentAdded: true,
      issue: {
        status: {
          name: "Done",
        },
      },
    });
    expect(client.transitionCalls).toEqual([
      {
        issueKey: "OPS-42",
        transitionId: "31",
        comment: "Mitigation deployed and metrics recovered.",
      },
    ]);
  });

  it("returns JSON project resources and incident-triage prompt messages", async () => {
    const server = createServer({
      environment: testEnvironment,
      client: new FakeJiraClient(),
    });

    const resource = await server.readProjectResource("OPS");
    const firstContent = resource.contents[0];
    const payload = JSON.parse(firstContent && "text" in firstContent ? firstContent.text : "{}") as {
      project?: {
        key?: string;
      };
    };
    const prompt = server.buildIncidentTriagePrompt({
      issueKey: "OPS-42",
      projectKey: undefined,
      summary: "API latency spike",
      symptoms: "Requests are timing out and latency exceeds 2 seconds.",
      impact: "Checkout requests are degraded.",
      suspectedService: "api-gateway",
      environment: "production",
    });

    expect(resource.contents[0]?.mimeType).toBe("application/json");
    expect(payload.project?.key).toBe("OPS");
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[1]?.content.text).toContain("OPS-42");
    expect(prompt.messages[1]?.content.text).toContain("jira://projects/OPS");
  });
});
