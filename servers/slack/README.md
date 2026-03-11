Use Slack from MCP to find channels, read recent messages, and post updates.

## What it can do
- `list_channels`: lists channels the bot can see, with paging and an option to include archived ones.
- `fetch_channel_history`: pulls recent messages from a channel, plus thread info and paging cursors.
- `post_message`: sends a new message to a channel or thread.

## Setup
This server needs one env var:
- `SLACK_BOT_TOKEN`: your Slack bot token (`xoxb-...`). Create or open an app at [api.slack.com/apps](https://api.slack.com/apps), install it to your workspace, then copy the **Bot User OAuth Token** from [OAuth & Permissions](https://api.slack.com/authentication/oauth-v2).
Make sure the bot can read the channels you care about and post in the ones you want to use.

## Claude Desktop config
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-slack@latest"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-slack@latest"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-bot-token"
      }
    }
  }
}
```

## Quick example
Ask Claude: "List channels that match `eng` or `release`, pull the last 10 messages from the release channel, then draft a short update I can post about today's deploy."
