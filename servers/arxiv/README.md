Search arXiv, fetch a paper by ID, and pull recent papers from a category.

## What it can do
- `search_papers` - Search arXiv by keyword or phrase and return matching papers.
- `get_paper` - Fetch one paper by arXiv ID with its summary, authors, categories, and links.
- `list_recent_papers` - Show the newest papers in an arXiv category like `cs.AI`.

## Setup
You can run this server as-is. No env vars required.

## Claude Desktop config
```json
{
  "mcpServers": {
    "arxiv": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-arxiv@latest"],
      "env": {}
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "arxiv": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-arxiv@latest"],
      "env": {}
    }
  }
}
```

## Quick example
`Find 5 recent arXiv papers about multimodal retrieval in cs.CL, then open the most useful one and give me a short summary with the paper link.`
