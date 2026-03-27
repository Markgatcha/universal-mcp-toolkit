# Playwright MCP Server

A Model Context Protocol server for browser automation using Playwright.

## Tools

- **playwright_navigate** — Navigate to a URL with optional wait strategy
- **playwright_screenshot** — Take a screenshot of the page or element (returns base64)
- **playwright_click** — Click an element by CSS selector
- **playwright_fill** — Fill an input field by selector
- **playwright_evaluate** — Execute JavaScript in page context
- **playwright_get_text** — Get text content from page or element
- **playwright_get_links** — Get all links from page or from a container
- **playwright_wait_for** — Wait for an element to appear
- **playwright_close** — Close the current browser session

## Setup

No required environment variables. Optional: PLAYWRIGHT_BROWSER (default: chromium)

Install browser: npx playwright install chromium

## Usage

```bash
# With stdio transport
npx @contextcore/mcp-playwright

# With HTTP+SSE transport
npx @contextcore/mcp-playwright --transport sse --port 3000
```

## Configuration

| Env Variable | Required | Description |
|--------------|----------|-------------|
| PLAYWRIGHT_BROWSER | No | Browser to use: chromium, firefox, webkit (default: chromium) |

## Client Integration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@contextcore/mcp-playwright"]
    }
  }
}
```
