Use this MCP server to inspect Docker containers, images, and basic daemon info.

## What it can do
- `list_containers` - Lists containers on the current Docker daemon, with status, image, ports, networks, and mount count.
- `inspect_container` - Shows full details for one container, including its command, env vars, mounts, health, and restart count.
- `list_images` - Lists images on the current Docker daemon, with tags, size, labels, and container count.

## Setup
No required env vars. If Docker is installed and running where this server can reach it, you can leave `env` empty.

## Claude Desktop config
```json
{
  "mcpServers": {
    "docker": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-docker@latest"],
      "env": {}
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "docker": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-docker@latest"],
      "env": {}
    }
  }
}
```

## Quick example
Try this in Claude:

"List my running Docker containers, inspect the `api` container, and tell me if its ports, mounts, or env vars look off."
