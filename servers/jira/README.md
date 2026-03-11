Jira MCP server for finding issues, reading tickets, and moving work in Jira Cloud.

## What it can do
- `search_issues`: Find issues with JQL or simple filters and get back short issue summaries.
- `get_issue`: Open one issue and pull its main fields, description text, and comments.
- `transition_issue`: Move an issue with a transition name or id, and optionally leave a comment.

## Setup
Set these env vars before you start:
- `JIRA_BASE_URL`: your Jira Cloud URL, like `https://your-team.atlassian.net`. Find it in Jira or Atlassian admin: [View product URLs](https://support.atlassian.com/organization-administration/docs/view-your-product-urls/)
- `JIRA_EMAIL`: the Atlassian account email tied to your Jira access: [Profile and visibility](https://id.atlassian.com/manage-profile/profile-and-visibility)
- `JIRA_API_TOKEN`: create an Atlassian API token here: [API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

## Claude Desktop config
```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-jira@latest"],
      "env": {
        "JIRA_BASE_URL": "https://your-team.atlassian.net",
        "JIRA_EMAIL": "you@example.com",
        "JIRA_API_TOKEN": "your_api_token"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-jira@latest"],
      "env": {
        "JIRA_BASE_URL": "https://your-team.atlassian.net",
        "JIRA_EMAIL": "you@example.com",
        "JIRA_API_TOKEN": "your_api_token"
      }
    }
  }
}
```

## Quick example
"Search Jira for open bugs in project WEB from the last 7 days, show me the top five, then open WEB-142 and summarize the latest comments." 
