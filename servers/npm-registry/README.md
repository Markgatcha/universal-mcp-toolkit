Search the npm registry, inspect package details, and list recent versions.

## What it can do
- `search_packages` — search npm for packages that match a text query.
- `get_package_metadata` — show package details like the latest version, dist-tags, maintainers, and version history.
- `list_package_versions` — list recent versions for a package and show its dist-tags.

## Setup
No required env vars. You can run this server as-is.

## Claude Desktop config
Add this to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "npm-registry": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-npm-registry@latest"],
      "env": {}
    }
  }
}
```

## Cursor config
Add this to your Cursor MCP config:

```json
{
  "mcpServers": {
    "npm-registry": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-npm-registry@latest"],
      "env": {}
    }
  }
}
```

## Quick example
Ask Claude: "Search npm for markdown parser packages, pick a strong match, then show its latest version and the 5 most recent releases."
