Use this server to search Linear issues, open a specific issue, and create new ones from Claude or Cursor.

## What it can do
- `search_issues`: search issues by text or an exact issue key like `ENG-123`, with optional team and state filters.
- `get_issue`: open one issue by UUID or by an issue key like `ENG-123`.
- `create_issue`: create a new issue in a chosen team, or use your default team if you set one.

## Setup
Set these env vars before you start. Only `LINEAR_API_KEY` is required:
- `LINEAR_API_KEY`: your Linear personal API key. Create it here: https://linear.app/settings/api
- `LINEAR_DEFAULT_TEAM_ID`: optional. Sets the default team ID for issue creation.
- `LINEAR_DEFAULT_TEAM_KEY`: optional. Sets the default team key for issue creation, like `ENG`.
- `LINEAR_WORKSPACE_NAME`: optional. Adds a friendly workspace name to responses.
- `LINEAR_API_URL`: optional. Leave this unset unless you need a custom GraphQL URL. The usual value is `https://api.linear.app/graphql`.
If you set both default team vars, make sure they point to the same team.

## Claude Desktop config
```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-linear@latest"],
      "env": {
        "LINEAR_API_KEY": "your_linear_api_key",
        "LINEAR_DEFAULT_TEAM_ID": "your_default_team_id",
        "LINEAR_DEFAULT_TEAM_KEY": "ENG",
        "LINEAR_WORKSPACE_NAME": "your_workspace_name",
        "LINEAR_API_URL": "https://api.linear.app/graphql"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-linear@latest"],
      "env": {
        "LINEAR_API_KEY": "your_linear_api_key",
        "LINEAR_DEFAULT_TEAM_ID": "your_default_team_id",
        "LINEAR_DEFAULT_TEAM_KEY": "ENG",
        "LINEAR_WORKSPACE_NAME": "your_workspace_name",
        "LINEAR_API_URL": "https://api.linear.app/graphql"
      }
    }
  }
}
```

## Quick example
Ask Claude:
> Search Linear for open issues about login redirects in team ENG. Open the best match and summarize it. If nothing already tracks it, create a new issue in ENG with a short bug report.
