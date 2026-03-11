Use Hacker News from Claude or Cursor: get top stories, search posts, and pull comment threads.

## What it can do
- `get_top_stories`: Gets the current top Hacker News stories with title, link, author, score, and comment count.
- `search_stories`: Searches Hacker News stories by keyword and returns matching posts.
- `get_item_thread`: Fetches one story and its comment thread, with depth and child limits you control.

## Setup
No env vars required. This server uses public Hacker News data, so you can run it right away.

## Claude Desktop config
```json
{
  "mcpServers": {
    "hackernews": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-hackernews@latest"],
      "env": {}
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "hackernews": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-hackernews@latest"],
      "env": {}
    }
  }
}
```

## Quick example
"Search Hacker News for stories about SQLite, pick the best match for local-first apps, fetch its thread two levels deep, and give me a short summary of the main takes and disagreements."
