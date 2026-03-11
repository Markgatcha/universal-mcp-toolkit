Redis MCP server for checking keys, TTLs, and basic cache health in Redis.

## What it can do
- `get-key` — read a key, show its type, TTL, size, and a decoded preview.
- `set-key` — write a key with JSON or string data, plus an optional TTL, when you explicitly opt in to writes.
- `inspect-server-info` — read Redis `INFO` and break it into easy-to-scan fields.

## Setup
You only need 1 env var:
- `REDIS_URL` — your Redis connection string. If you use Redis Cloud, open your database's Connect flow and copy the client connection details: https://redis.io/docs/latest/operate/rc/databases/connect/ . If you run Redis locally, `redis://localhost:6379` usually works.

## Claude Desktop config
```json
{
  "mcpServers": {
    "redis": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-redis@latest"],
      "env": {
        "REDIS_URL": "redis://default:password@your-redis-host:6379"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "redis": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-redis@latest"],
      "env": {
        "REDIS_URL": "redis://default:password@your-redis-host:6379"
      }
    }
  }
}
```

## Quick example
"Check why `session:user:42` keeps vanishing from Redis. Use `get-key` to inspect it, then run `inspect-server-info` and look for eviction or memory clues before you suggest any write."
