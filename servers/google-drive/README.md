Search Google Drive, check file details, and export Google Workspace files from Claude or Cursor.

## What it can do
- `search-files` - Find Drive files by text, file type, sort order, and page token.
- `get-file-metadata` - Get one file's name, owners, timestamps, size, parent folders, and Drive links.
- `export-file` - Export a Google Workspace file to plain text or another MIME type so your MCP client can read it.

## Setup
Set this env var before you start the server:

- `GOOGLE_DRIVE_ACCESS_TOKEN` - A Google OAuth access token with Google Drive access. Get one from Google's OAuth 2.0 Playground: https://developers.google.com/oauthplayground/ . If you need help with scopes or auth setup, use the Drive auth guide: https://developers.google.com/workspace/drive/api/guides/api-specific-auth

This token expires, so refresh it when Google tells you it has expired.

## Claude Desktop config
```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-google-drive@latest"],
      "env": {
        "GOOGLE_DRIVE_ACCESS_TOKEN": "your_google_drive_access_token"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-google-drive@latest"],
      "env": {
        "GOOGLE_DRIVE_ACCESS_TOKEN": "your_google_drive_access_token"
      }
    }
  }
}
```

## Quick example
Ask Claude: "Search my Drive for the latest Q2 planning doc, export it as text, and give me a short summary with decisions, deadlines, and open questions."
