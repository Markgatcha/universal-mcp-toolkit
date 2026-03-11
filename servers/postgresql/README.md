PostgreSQL MCP server for browsing your schema and running guarded SQL from Claude or Cursor.

## What it can do
- `list-tables` — show the tables and views your connection can see.
- `describe-table` — show a table's columns, types, defaults, and constraints.
- `run-query` — run SQL, return rows, and stop write queries unless you opt in.

## Setup
You only need one env var:
- `POSTGRESQL_URL` — your PostgreSQL connection string, like `postgresql://user:password@host:5432/dbname`. Copy it from your database provider's connection page, or build it with the official PostgreSQL format: https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING

## Claude Desktop config
```json
{
  "mcpServers": {
    "postgresql": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-postgresql@latest"],
      "env": {
        "POSTGRESQL_URL": "<your-postgresql-url>"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "postgresql": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-postgresql@latest"],
      "env": {
        "POSTGRESQL_URL": "<your-postgresql-url>"
      }
    }
  }
}
```

## Quick example
Ask Claude: `List the tables in the public schema, describe the orders table, then run SELECT id, customer_id, total, created_at FROM orders ORDER BY created_at DESC LIMIT 10;`
