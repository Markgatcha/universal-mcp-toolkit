Use this server to search Notion, read page details, and create child pages from Claude or Cursor.

## What it can do
- `search-pages` — finds pages by title or indexed text and returns paged results.
- `get-page` — fetches a page's properties and can include a short chunk of top-level content.
- `create-page` — creates a child page under a parent page and can add starter content.

## Setup
You need one env var:
- `NOTION_TOKEN` — your Notion integration token. Create an internal integration and copy the token from [Notion integrations](https://www.notion.so/profile/integrations). If you want the full walkthrough, use [Notion's official guide](https://developers.notion.com/docs/create-a-notion-integration).

Also share the pages or databases you want to use with that integration, or Notion will block access.

## Claude Desktop config
Add this to your MCP config:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-notion@latest"],
      "env": {
        "NOTION_TOKEN": "your_notion_integration_token"
      }
    }
  }
}
```

## Cursor config
Add this to your Cursor MCP config:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-notion@latest"],
      "env": {
        "NOTION_TOKEN": "your_notion_integration_token"
      }
    }
  }
}
```

## Quick example
Prompt Claude with:

> Search Notion for pages about "Q2 planning", open the best match, and give me a short summary of the goals, deadlines, and owners.
