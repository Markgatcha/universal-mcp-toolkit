---
"universal-mcp-toolkit-monorepo": patch
---
Fixed 5 security vulnerabilities by bumping transitive dependency overrides in `pnpm-workspace.yaml`:

- **hono** 4.12.34 → 4.13.0 — resolves Algorithmic Complexity DoS (Language Middleware), ReDoS in CORS middleware (Access-Control-Request-Headers), data leakage via `memo()` retaining SSR output across requests, and response header leakage in Proxy Helper Connection header handling.
- **fast-uri** 3.1.5 → 4.1.2 — resolves host confusion vulnerabilities: CVE-2026-6322 (percent-encoded authority delimiters), CVE-2026-16221 (literal backslash authority delimiter), CVE-2026-18446 (backslash authority introducer).
- **ip-address** 10.3.1 → 10.4.0 — latest clean release (10.3.1 was the initial CVE-2026-69192 fix; 10.4.0 confirmed 0 vulnerabilities by Snyk).
- **js-yaml** — range overrides for 3.x bumped to 3.15.1 and 4.x bumped to 4.3.1, resolving CVE-2026-59870 (Quadratic CPU consumption in `!!omap` resolution).
- **nanoid** 3.3.16 → 3.3.18 — resolves CVE-2026-67213 (infinite loop in custom generators when size is zero).
