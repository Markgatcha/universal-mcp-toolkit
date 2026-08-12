# Deterministic workflows

UMT workflows are small, reviewable JSON files that execute MCP tools sequentially. Version 1 intentionally keeps the format narrow: explicit servers and tools, exact references, predictable ordering, and no model-generated code.

## Validate a workflow

```bash
umt workflow validate examples/workflows/github-search-to-slack.json
```

Validation rejects unsupported properties, duplicate step IDs, unknown inputs, forward step references, and malformed references before any MCP server is started.

## Run a workflow

The included example searches GitHub and posts the rendered search result to Slack:

```bash
umt workflow run examples/workflows/github-search-to-slack.json \
  --input '{"query":"model context protocol","channelId":"C0123456789"}'
```

Set `GITHUB_TOKEN` and `SLACK_BOT_TOKEN` before running it.

## Format

```json
{
  "version": "umt.dev/workflow/v1",
  "name": "example",
  "inputs": ["query"],
  "steps": [
    {
      "id": "search",
      "server": "github",
      "tool": "search_repositories",
      "args": {
        "query": "$inputs.query"
      }
    },
    {
      "id": "publish",
      "server": "slack",
      "tool": "post_message",
      "args": {
        "text": "$steps.search.output"
      }
    }
  ]
}
```

References must occupy the complete JSON string value so their original type can be preserved:

- `$inputs.<name>` resolves a declared workflow input.
- `$steps.<id>.output` resolves the complete text output of an earlier step.

Each step opens an isolated bridge connection and disconnects it in a `finally` block. Execution stops on the first failed tool result. Version 1 does not provide parallel execution, interpolation inside larger strings, retries, or durable state; those can be added through future versioned formats without making existing workflows ambiguous.
