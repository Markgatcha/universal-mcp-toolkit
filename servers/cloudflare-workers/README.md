Use this server to list your Cloudflare Workers, inspect one worker, and check the routes tied to it.

## What it can do
- `list_workers` - Lists worker scripts in your Cloudflare account and shows the basics for each one.
- `get_worker` - Shows settings for one worker, including bindings, placement mode, and logpush.
- `list_routes` - Lists worker routes and can filter them down to one script.

## Setup
Set these env vars before you start:
- `CLOUDFLARE_API_TOKEN`: create a Cloudflare API token here: https://dash.cloudflare.com/profile/api-tokens/ and see the docs here: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- `CLOUDFLARE_ACCOUNT_ID`: copy your account ID here: https://dash.cloudflare.com/?to=/:account/home or use these docs: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/
Those are the only required env vars.

## Claude Desktop config
```json
{
  "mcpServers": {
    "cloudflare-workers": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-cloudflare-workers@latest"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your_cloudflare_api_token",
        "CLOUDFLARE_ACCOUNT_ID": "your_cloudflare_account_id"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "cloudflare-workers": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-cloudflare-workers@latest"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your_cloudflare_api_token",
        "CLOUDFLARE_ACCOUNT_ID": "your_cloudflare_account_id"
      }
    }
  }
}
```

## Quick example
"List my Workers, show the settings for `marketing-edge`, then list the routes attached to it and point out anything that might break a rollout."
