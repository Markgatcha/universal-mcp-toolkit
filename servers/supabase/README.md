Use this server to browse Supabase tables and storage from Claude or Cursor.

## What it can do
- `list-storage-buckets`: shows the storage buckets in your Supabase project.
- `list-tables`: shows the tables in a schema, usually `public`.
- `query-table`: reads rows from a table with filters, sorting, and a row limit.

## Setup
Set these env vars before you start:
- `SUPABASE_URL`: your project URL from Supabase Project Settings → API: https://supabase.com/dashboard/project/_/settings/api
- `SUPABASE_KEY`: your API key from Supabase Project Settings → API Keys: https://supabase.com/docs/guides/api/api-keys

## Claude Desktop config
```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-supabase@latest"],
      "env": {
        "SUPABASE_URL": "https://your-project-ref.supabase.co",
        "SUPABASE_KEY": "your-supabase-key"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-supabase@latest"],
      "env": {
        "SUPABASE_URL": "https://your-project-ref.supabase.co",
        "SUPABASE_KEY": "your-supabase-key"
      }
    }
  }
}
```

## Quick example
Ask Claude:
> Look at the `public.orders` table in my Supabase project. Show me the 10 newest rows where `status` is `failed`, then list my storage buckets so I can check where related files might live.
