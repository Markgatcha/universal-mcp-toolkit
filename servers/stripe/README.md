Use this server to check Stripe customers, invoices, and subscriptions from Claude or Cursor.

## What it can do
- `list-customers`: Find Stripe customers, and filter by email when you know the address.
- `get-invoice`: Open one invoice and see totals, line items, status, and hosted links.
- `list-subscriptions`: List subscriptions for your account or for one customer, with status filters.

## Setup
Set `STRIPE_SECRET_KEY`.
Get it from Stripe Dashboard: https://dashboard.stripe.com/apikeys
Docs: https://docs.stripe.com/keys

## Claude Desktop config
```json
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-stripe@latest"],
      "env": {
        "STRIPE_SECRET_KEY": "${STRIPE_SECRET_KEY}"
      }
    }
  }
}
```

## Cursor config
```json
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-stripe@latest"],
      "env": {
        "STRIPE_SECRET_KEY": "${STRIPE_SECRET_KEY}"
      }
    }
  }
}
```

## Quick example
```text
Find the Stripe customer for jamie@acme.co, show any active or past_due subscriptions, and summarize what I should check before the next renewal.
```
