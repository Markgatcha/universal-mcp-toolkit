import { describe, expect, it } from "vitest";

import type {
  LinearClient,
  LinearCreateIssueInput,
  LinearIssueDetail,
  LinearIssueSearchRequest,
  LinearIssueSummary,
  LinearTeam,
} from "../src/index.js";
import { LinearServer, metadata, serverCard } from "../src/index.js";

class FakeLinearClient implements LinearClient {
  public readonly createdIssues: LinearCreateIssueInput[] = [];
  private readonly teams: readonly [LinearTeam, LinearTeam];
  private readonly issues: LinearIssueDetail[];

  public constructor() {
    this.teams = [
      { id: "team-eng", key: "ENG", name: "Engineering" },
      { id: "team-ops", key: "OPS", name: "Operations" },
    ];
    this.issues = [
      {
        id: "issue-1",
        identifier: "ENG-101",
        title: "Investigate login failures",
        description: "Users intermittently hit a stale session error after deploys.",
        url: "https://linear.app/example/issue/ENG-101/investigate-login-failures",
        branchName: "eng-101-investigate-login-failures",
        priority: 2,
        state: {
          name: "In Progress",
          type: "started",
        },
        team: this.teams[0],
        assignee: {
          id: "user-1",
          name: "Alicia",
        },
        cycle: {
          id: "cycle-42",
          number: 42,
          name: "Sprint 42",
          startsAt: "2026-03-01T00:00:00.000Z",
          endsAt: "2026-03-15T00:00:00.000Z",
        },
        createdAt: "2026-03-02T09:00:00.000Z",
        updatedAt: "2026-03-05T13:00:00.000Z",
      },
      {
        id: "issue-2",
        identifier: "OPS-44",
        title: "Rotate expired webhook secret",
        description: "Replace the webhook secret used by the Linear ingestion worker.",
        url: "https://linear.app/example/issue/OPS-44/rotate-expired-webhook-secret",
        branchName: null,
        priority: 1,
        state: {
          name: "Backlog",
          type: "unstarted",
        },
        team: this.teams[1],
        assignee: null,
        cycle: null,
        createdAt: "2026-03-04T10:00:00.000Z",
        updatedAt: "2026-03-04T10:00:00.000Z",
      },
    ];
  }

  public async listTeams(): Promise<LinearTeam[]> {
    return [...this.teams];
  }

  public async searchIssues(input: LinearIssueSearchRequest): Promise<LinearIssueSummary[]> {
    return this.issues
      .filter((issue) => (input.teamId ? issue.team?.id === input.teamId : true))
      .filter((issue) => (input.stateName ? issue.state.name === input.stateName : true))
      .filter((issue) => {
        if (input.issueNumber !== undefined) {
          const [, rawNumber = "0"] = issue.identifier.split("-");
          return Number.parseInt(rawNumber, 10) === input.issueNumber;
        }

        return issue.title.toLowerCase().includes(input.query.toLowerCase());
      })
      .slice(0, input.limit)
      .map((issue) => ({
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
      }));
  }

  public async getIssueById(id: string): Promise<LinearIssueDetail> {
    const issue = this.issues.find((candidate) => candidate.id === id || candidate.identifier === id);
    if (!issue) {
      throw new Error(`Unknown issue ${id}`);
    }

    return issue;
  }

  public async getIssueByIdentifier(teamId: string, issueNumber: number): Promise<LinearIssueDetail> {
    const issue = this.issues.find((candidate) => {
      const [, rawNumber = "0"] = candidate.identifier.split("-");
      return candidate.team?.id === teamId && Number.parseInt(rawNumber, 10) === issueNumber;
    });

    if (!issue) {
      throw new Error(`Unknown issue ${teamId}#${issueNumber}`);
    }

    return issue;
  }

  public async createIssue(input: LinearCreateIssueInput): Promise<LinearIssueDetail> {
    this.createdIssues.push(input);

    const team = this.teams.find((candidate) => candidate.id === input.teamId);
    if (!team) {
      throw new Error(`Unknown team ${input.teamId}`);
    }

    return {
      id: "issue-3",
      identifier: `${team.key}-999`,
      title: input.title,
      description: input.description ?? null,
      url: `https://linear.app/example/issue/${team.key}-999/${input.title.toLowerCase().replace(/\s+/g, "-")}`,
      branchName: null,
      priority: input.priority ?? null,
      state: {
        name: "Triage",
        type: "unstarted",
      },
      team,
      assignee: null,
      cycle: null,
      createdAt: "2026-03-06T09:30:00.000Z",
      updatedAt: "2026-03-06T09:30:00.000Z",
    };
  }
}

function createTestServer(client = new FakeLinearClient()): LinearServer {
  return new LinearServer({
    client,
    defaultTeamId: "team-eng",
    defaultTeamKey: "ENG",
    workspaceName: "Acme Workspace",
  });
}

describe("LinearServer smoke", () => {
  it("registers discovery metadata that matches the actual handlers", () => {
    const server = createTestServer();

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
    expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
    expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

    expect(serverCard.tools).toEqual(metadata.toolNames);
    expect(serverCard.resources).toEqual(metadata.resourceNames);
    expect(serverCard.prompts).toEqual(metadata.promptNames);
  });

  it("searches issues and fetches an issue by identifier using the injected client", async () => {
    const server = createTestServer();

    const searchResult = await server.invokeTool<{
      total: number;
      team: { key: string } | null;
      issues: Array<{ identifier: string }>;
    }>("search_issues", {
      query: "login",
      limit: 5,
    });

    expect(searchResult.total).toBe(1);
    expect(searchResult.team?.key).toBe("ENG");
    expect(searchResult.issues[0]?.identifier).toBe("ENG-101");

    const getIssueResult = await server.invokeTool<{ issue: { identifier: string; title: string } }>("get_issue", {
      idOrIdentifier: "ENG-101",
    });

    expect(getIssueResult.issue.identifier).toBe("ENG-101");
    expect(getIssueResult.issue.title).toBe("Investigate login failures");
  });

  it("creates issues and exposes team resource and prompt helpers without live network access", async () => {
    const client = new FakeLinearClient();
    const server = createTestServer(client);

    const createResult = await server.invokeTool<{
      created: boolean;
      issue: { identifier: string; team: { key: string } | null };
    }>("create_issue", {
      title: "Triage stale sessions",
      description: "Investigate why session tokens remain cached after deploys.",
      priority: 2,
    });

    expect(createResult.created).toBe(true);
    expect(createResult.issue.identifier).toBe("ENG-999");
    expect(createResult.issue.team?.key).toBe("ENG");
    expect(client.createdIssues[0]).toMatchObject({
      teamId: "team-eng",
      title: "Triage stale sessions",
      priority: 2,
    });

    const teamResource = await server.getTeamResourcePayload();
    expect(teamResource.defaultTeam?.key).toBe("ENG");
    expect(teamResource.accessibleTeams).toHaveLength(2);
    expect(teamResource.workspaceName).toBe("Acme Workspace");

    const prompt = await server.createSprintTriagePrompt({
      focus: "reliability",
      issueLimit: 6,
      includeBacklog: false,
    });

    expect(prompt.messages).toHaveLength(1);

    const firstMessage = prompt.messages[0];
    expect(firstMessage?.role).toBe("user");

    if (!firstMessage || firstMessage.content.type !== "text") {
      throw new Error("Expected the prompt to contain a text message.");
    }

    expect(firstMessage.content.text).toContain("Acme Workspace");
    expect(firstMessage.content.text).toContain("Engineering (ENG)");
    expect(firstMessage.content.text).toContain("reliability");
    expect(firstMessage.content.text).toContain("search_issues");
    expect(firstMessage.content.text).toContain("linear://team/default");
  });
});
