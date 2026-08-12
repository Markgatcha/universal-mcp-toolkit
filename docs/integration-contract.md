# UMT integration contract

`@universal-mcp-toolkit/core` exports a strict, versioned integration manifest schema for documenting evidence consistently without requiring every server to migrate at once.

```ts
import {
  UMT_INTEGRATION_SCHEMA_VERSION,
  summarizeIntegrationReadiness,
  validateIntegrationManifest,
} from "@universal-mcp-toolkit/core";

const manifest = validateIntegrationManifest({
  schemaVersion: UMT_INTEGRATION_SCHEMA_VERSION,
  id: "github",
  title: "GitHub",
  version: "1.0.0",
  maturity: "beta",
  packageName: "@universal-mcp-toolkit/server-github",
  maintainership: "first-party",
  transports: ["stdio", "streamable-http"],
  auth: {
    envVars: ["GITHUB_TOKEN"],
    scopes: ["repo:read"]
  },
  tools: [
    {
      name: "search_repositories",
      behavior: {
        readOnly: true,
        destructive: false,
        idempotent: true
      }
    }
  ],
  conformance: {
    contractTests: ["test/contract.test.ts"],
    launchTest: "ci:launch-test",
    securityReview: "docs:security-review",
    protocolRevisions: ["2025-06-18"]
  }
});

console.log(summarizeIntegrationReadiness(manifest));
```

The readiness helper reports which evidence is present or missing. It does not automatically declare an integration secure or production-ready; maintainers remain responsible for reviewing the linked evidence.

## Contract fields

- **Maturity:** `stable`, `beta`, `experimental`, or `external`
- **Maintainership:** `first-party`, `community`, or `external`
- **Transports:** `stdio`, `streamable-http`, and legacy `sse`
- **Authentication:** required environment variables and upstream scopes
- **Tool behavior:** read-only, destructive, and idempotent annotations
- **Conformance evidence:** contract tests, launch test, security review, and tested protocol revisions

Manifests are strict and reject unknown fields, duplicate tool names, duplicate evidence, malformed package names, and contradictory read-only/destructive annotations.
