Use Hacker News from Claude or Cursor: read ranked story lists, search posts, and pull comment threads from public Hacker News APIs.

## What it can do
- `get_top_stories`: Returns current front-page/topstories summaries. `limit` defaults to 10 and accepts 1-30.
- `get_new_stories`: Returns newest story summaries when recency matters more than score. `limit` defaults to 10 and accepts 1-30.
- `get_best_stories`: Returns HN beststories summaries when broader popularity/quality ranking matters. `limit` defaults to 10 and accepts 1-30.
- `search_stories`: Searches stories by non-empty keyword query through Algolia HN search, ranked by Algolia relevance/popularity rather than exact phrase matching. `limit` defaults to 10 and accepts 1-30.
- `get_item_thread`: Fetches one known item and expands comments. `itemId` is a nonnegative HN item ID, `depth` defaults to 2 and accepts 1-6, and `maxChildren` defaults to 20 and accepts 1-50 per node.

## Setup
No env vars or Hacker News authentication are required. The server is read-only, idempotent, caches GET responses in memory for 60 seconds, and throttles upstream HN/Algolia requests to 10 requests/second with a burst of 20.

Posting, commenting, and voting are intentionally not exposed because this package uses public read APIs and does not collect Hacker News credentials.

## When to use each tool
- Use `get_top_stories` for "front page", "top", or current popular story requests.
- Use `get_new_stories` for newest submissions.
- Use `get_best_stories` for HN's broader best ranking.
- Use `search_stories` when the user provides a topic, phrase, company, or technology name.
- Use `get_item_thread` after a story-list or search result gives you a specific item ID and you need discussion context.

Deleted, dead, or missing child items are skipped, so a response can contain fewer records than requested. Missing root items in `get_item_thread` return a tool error, while no-match searches return an empty `stories` array.

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

## Quick examples
"Get the newest Hacker News stories about developer tools, then fetch the best matching thread two levels deep and summarize the main disagreements."

"Compare the current top stories and best stories, then list which themes appear in both rankings."
