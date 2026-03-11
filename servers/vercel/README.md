Use Vercel projects, deployments, and account info from Claude or Cursor.

## What it can do
- `list_projects`: Show the Vercel projects your token can see, with optional search and a limit.
- `list_deployments`: Show recent deployments, and filter by project or by `production` or `preview`.
- `get_deployment`: Show the full details for one deployment ID.

## Setup
Set these env vars before you start:
- `VERCEL_TOKEN` (required): create a token at https://vercel.com/account/tokens
- `VERCEL_TEAM_ID` (optional): if you want to scope calls to one team, get the team ID from your Vercel team settings at https://vercel.com/teams

If you only use a personal account, you can leave `VERCEL_TEAM_ID` out.

## Claude Desktop config
```json
{
  "mcpServers": {
    "vercel": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-vercel@latest"],
      "env": {
        "VERCEL_TOKEN": "your_vercel_token",
        "VERCEL_TEAM_ID": "your_team_id"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "vercel": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-vercel@latest"],
      "env": {
        "VERCEL_TOKEN": "your_vercel_token",
        "VERCEL_TEAM_ID": "your_team_id"
      }
    }
  }
}
```

## Quick example
Ask Claude: "List my 5 newest production deployments, then open the most recent failed one and tell me what I should check before I roll it back."
