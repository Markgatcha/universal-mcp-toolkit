Use this server to search GitHub, inspect repos and pull requests, and make common repo changes.

## What it can do
- `comment_on_issue`: add a comment to an issue.
- `create_issue`: open a new issue with a title, body, and labels.
- `create_or_update_file`: create a file or replace one with a commit.
- `create_pull_request`: open a PR from one branch into another.
- `get_file_contents`: read a file from a repo, with an optional ref.
- `get_pull_request`: fetch a PR and show status, reviewers, and diff summary.
- `list_commits`: show recent commits for a repo or branch.
- `list_issues`: list issues and filter by state, labels, or assignee.
- `list_releases`: list releases with tags, dates, and notes.
- `list_workflow_runs`: show recent GitHub Actions runs and filter them.
- `merge_pull_request`: merge a PR with merge, squash, or rebase.
- `search_repositories`: find repos your token can see.

## Setup
Set this env var before you start:
- `GITHUB_TOKEN`: a GitHub personal access token. Create one here: https://github.com/settings/personal-access-tokens/new
That is the only required env var.

## Claude Desktop config
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-github@latest"],
      "env": {
        "GITHUB_TOKEN": "your_github_token_here"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-github@latest"],
      "env": {
        "GITHUB_TOKEN": "your_github_token_here"
      }
    }
  }
}
```

## Quick example
"Find the `cli/cli` repo, list its latest 5 releases, then fetch `README.md` from the default branch and give me a short summary."
