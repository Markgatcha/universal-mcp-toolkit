Safe file access inside the folders you allow.

## What it can do
- `list_files` — shows files and folders under an allowlisted root, with optional recursion and entry limits.
- `read_file` — reads a file from an allowlisted root as text or base64.
- `write_file` — writes a file inside an allowlisted root, with options to create folders or block overwrites.

## Setup
Set `FILESYSTEM_ROOTS` to one or more absolute folder paths, separated with `;`.
Example: `C:\Users\you\Documents;C:\Users\you\Projects`
You do not get this from a service. You pick the folders on your own machine.
Helpful docs for path format:
- [Windows absolute path guide](https://learn.microsoft.com/windows/win32/fileio/naming-a-file)

## Claude Desktop config
Add this to your Claude Desktop MCP config:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-filesystem@latest"],
      "env": {
        "FILESYSTEM_ROOTS": "C:\\Users\\you\\Documents;C:\\Users\\you\\Projects"
      }
    }
  }
}
```

## Cursor config
Put this in `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-filesystem@latest"],
      "env": {
        "FILESYSTEM_ROOTS": "C:\\Users\\you\\Documents;C:\\Users\\you\\Projects"
      }
    }
  }
}
```

## Quick example
"Look in my allowlisted `Projects\\api` folder, list the top-level files, read `package.json`, and create `notes\\release-checklist.txt` with a short launch checklist."
