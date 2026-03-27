# Slack MCP Server

A Model Context Protocol server for full Slack workspace integration.

## Tools

- **slack_list_channels** — List all channels with pagination
- **slack_get_channel** — Get channel information by ID
- **slack_post_message** — Post a message to a channel or thread
- **slack_get_messages** — Get recent messages from a channel
- **slack_search_messages** — Search messages by query
- **slack_get_user** — Get user information by ID
- **slack_list_users** — List all workspace users
- **slack_upload_file** — Upload a file to a channel
- **slack_add_reaction** — Add a reaction to a message
- **slack_get_thread** — Get full thread replies

## Setup

Requires SLACK_BOT_TOKEN environment variable.

Get a bot token from your Slack app at api.slack.com.

## Usage

```bash
npx @contextcore/mcp-slack
npx @contextcore/mcp-slack --transport sse --port 3000
```

## Configuration

| Env Variable | Required | Description |
|--------------|----------|-------------|
| SLACK_BOT_TOKEN | Yes | Your Slack bot token |
| SLACK_TEAM_ID | No | Team ID |
| SLACK_SIGNING_SECRET | No | For event subscriptions |

## Client Integration

### Claude Desktop

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@contextcore/mcp-slack"]
    }
  }
}
```
