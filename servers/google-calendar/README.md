Use this server to check your Google calendars, list events, and create new meetings from Claude or Cursor.

## What it can do
- `list-calendars`: Shows the calendars you can access, including shared calendars.
- `list-events`: Shows events from a calendar, with an optional time range, search text, paging, and sort order.
- `create-event`: Creates a calendar event with a title, time, attendees, notes, and location.

## Setup
You only need one required env var: `GOOGLE_CALENDAR_ACCESS_TOKEN`.
Get Google OAuth credentials here: https://console.cloud.google.com/apis/credentials
Mint or test a token here: https://developers.google.com/oauthplayground/
Use a Calendar scope like `https://www.googleapis.com/auth/calendar.events` or `https://www.googleapis.com/auth/calendar`.

## Claude Desktop config
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-google-calendar@latest"],
      "env": {
        "GOOGLE_CALENDAR_ACCESS_TOKEN": "your_google_calendar_access_token"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-google-calendar@latest"],
      "env": {
        "GOOGLE_CALENDAR_ACCESS_TOKEN": "your_google_calendar_access_token"
      }
    }
  }
}
```

## Quick example
"Show my events for tomorrow on my primary calendar, then create a 30-minute project sync at 3:00 PM with alex@example.com and add 'review launch checklist' to the notes."
