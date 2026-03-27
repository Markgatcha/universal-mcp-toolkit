# OpenAI MCP Server

A Model Context Protocol server for OpenAI/Codex API integration.

## Tools

- **openai_chat** — Chat completion with GPT models
- **openai_complete** — Simple text completion
- **openai_embed** — Text embedding generation
- **openai_list_models** — List available models
- **openai_image_generate** — Image generation with DALL-E
- **openai_moderate** — Content moderation
- **openai_transcribe** — Audio transcription with Whisper
- **openai_function_call** — Structured function calling

## Setup

Requires OPENAI_API_KEY environment variable.

Supports custom endpoints via OPENAI_BASE_URL for Ollama, LM Studio, Together, etc.

## Usage

```bash
npx @contextcore/mcp-openai
npx @contextcore/mcp-openai --transport sse --port 3000
```

## Configuration

| Env Variable | Required | Description |
|--------------|----------|-------------|
| OPENAI_API_KEY | Yes | Your OpenAI API key |
| OPENAI_BASE_URL | No | Custom endpoint URL |
| OPENAI_DEFAULT_MODEL | No | Default model (gpt-4o) |

## Client Integration

### Claude Desktop

```json
{
  "mcpServers": {
    "openai": {
      "command": "npx",
      "args": ["-y", "@contextcore/mcp-openai"]
    }
  }
}
```
