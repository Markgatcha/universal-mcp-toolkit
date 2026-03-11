Spotify MCP server for checking what's playing, finding tracks, listing playlists, and pulling listener context.

## What it can do
- `currently-playing`: Shows the track on your active player and can include device info.
- `search-tracks`: Finds tracks by search text and returns the best matches.
- `list-playlists`: Lists your Spotify playlists with names and track counts.

## Setup
Set `SPOTIFY_ACCESS_TOKEN` to a Spotify user access token.

Get it from Spotify's official pages:
- Dashboard: https://developer.spotify.com/dashboard
- Auth guide: https://developer.spotify.com/documentation/web-api/tutorials/code-flow

Use a user token with the scopes you need, like `user-read-currently-playing`, `user-read-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, and `user-read-email`.

You only need `SPOTIFY_ACCESS_TOKEN`. No other env vars are required.

## Claude Desktop config
```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-spotify@latest"],
      "env": {
        "SPOTIFY_ACCESS_TOKEN": "your_spotify_access_token"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-spotify@latest"],
      "env": {
        "SPOTIFY_ACCESS_TOKEN": "your_spotify_access_token"
      }
    }
  }
}
```

## Quick example
"Check what's playing right now. Then search Spotify for 5 dreamy synth-pop tracks like M83 or CHVRCHES, and show my first 10 playlists."
