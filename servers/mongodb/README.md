Use this server to browse MongoDB collections and query documents from Claude Desktop or Cursor.

## What it can do
- `list-collections` shows collections in a database and can filter by name prefix.
- `find-documents` runs a normal find query with filter, projection, sort, limit, and skip.
- `aggregate-documents` runs an aggregation pipeline and returns matching documents; write stages stay off unless you opt in.

## Setup
Set this env var:
- `MONGODB_URI`: your MongoDB connection string. Get it from the Atlas connect flow at https://www.mongodb.com/docs/atlas/connect-to-database-deployment/ or build one with the MongoDB connection string docs at https://www.mongodb.com/docs/manual/reference/connection-string/

## Claude Desktop config
```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-mongodb@latest"],
      "env": {
        "MONGODB_URI": "${MONGODB_URI}"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-mongodb@latest"],
      "env": {
        "MONGODB_URI": "${MONGODB_URI}"
      }
    }
  }
}
```

## Quick example
Ask Claude:

> Use the MongoDB server to list collections in my default database, then check the last 10 documents in `orders` where `status` is `failed` and tell me the most common error messages.
