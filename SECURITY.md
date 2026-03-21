# Security Policy

## Supported Versions

We take security seriously. The following versions of `universal-mcp-toolkit` are currently receiving security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

---

## Reporting a Vulnerability

If you discover a security vulnerability in `universal-mcp-toolkit`, please **do not open a public GitHub issue**. Public disclosure before a fix is in place puts users at risk.

Instead, please report it privately:

**Email:** open a [GitHub Security Advisory](https://github.com/Markgatcha/universal-mcp-toolkit/security/advisories/new) via the Security tab, or reach out directly through GitHub.

When reporting, please include:

- A clear description of the vulnerability and the potential impact
- The version(s) affected
- Steps to reproduce or a proof-of-concept (if applicable)
- Any suggested mitigations you may have identified

We will acknowledge your report within **72 hours** and aim to release a patch within **14 days** of confirmation, depending on severity.

---

## Scope

This policy covers:

- The `universal-mcp-toolkit` CLI (`packages/cli`)
- The `@universal-mcp-toolkit/core` runtime package (`packages/core`)
- All server packages under `servers/`
- CI workflows and build tooling under `.github/`

Out of scope:

- Security issues in upstream third-party API providers (GitHub, Notion, Slack, Stripe, etc.) — report those directly to the respective vendor
- Vulnerabilities in `node_modules` dependencies — report those to the maintainers of the affected package via their own security policy

---

## Security Best Practices for Users

- **Never commit `.env` files.** The root `.env.example` is for reference only.
- **Rotate tokens regularly.** All server integrations use API tokens; treat them as secrets.
- **Use the `FILESYSTEM_ROOTS` variable** to restrict file system access to only the directories your agent needs.
- **Review `POSTGRESQL_ALLOW_WRITES` and `REDIS_ALLOW_WRITES`** before enabling them in shared environments.
- **Run with least-privilege tokens.** Use read-only API tokens where write access isn't required.

---

## Disclosure Policy

Once a fix is released, we will:

1. Publish a patched version on npm
2. Update the `CHANGELOG.md` with a security notice
3. Open a GitHub Security Advisory with full disclosure details
4. Credit the reporter (with their permission)

Thank you for helping keep `universal-mcp-toolkit` and its users safe.
