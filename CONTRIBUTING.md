# Contributing to universal-mcp-toolkit

First off — thanks for taking the time to contribute. This project is built on the idea that a well-structured MCP monorepo can be a real reference for the community, and every contribution helps make that more true.

Please read this guide before opening issues or pull requests. It keeps things moving smoothly for everyone.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Contributing Code](#contributing-code)
  - [Adding a New Server](#adding-a-new-server)
- [Development Setup](#development-setup)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Commit Message Style](#commit-message-style)
- [Code Style](#code-style)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Please report any unacceptable behavior through the GitHub Security tab or by opening a private advisory.

---

## How Can I Contribute?

### Reporting Bugs

Before filing a bug report, please check the [existing issues](https://github.com/Markgatcha/universal-mcp-toolkit/issues) to avoid duplicates.

When opening a new issue, include:

- The exact `umt` command or server name involved
- Your Node.js version (`node --version`) and OS
- The full error message or unexpected output
- Steps to reproduce reliably
- What you expected to happen

The more detail you include, the faster the issue can be triaged.

### Suggesting Enhancements

Feature requests and ideas are welcome. Open an issue with the `enhancement` label and describe:

- What problem the feature solves or what workflow it enables
- Any alternative approaches you considered
- Whether you’d be willing to implement it

For large changes (new transports, major CLI redesigns, new core abstractions), please open a discussion first so we can align before any code is written.

### Contributing Code

1. Fork the repository
2. Create a branch from `main` with a descriptive name (e.g. `fix/postgresql-connection-timeout`, `feat/server-linear-bulk-ops`)
3. Make your changes following the [code style guidelines](#code-style)
4. Add or update tests for any changed behavior
5. Run the full build and test suite locally before pushing
6. Open a pull request against `main` with a clear description

### Adding a New Server

Want to add an integration that isn’t in the toolkit yet? Here’s the checklist:

- [ ] Create a new directory under `servers/your-service/`
- [ ] Extend `ToolkitServer` from `@universal-mcp-toolkit/core`
- [ ] Define tools with `defineTool` and Zod schemas for all inputs and outputs
- [ ] Add a `.well-known/mcp-server.json` discovery card
- [ ] Export a `package.json` with correct `name`, `keywords`, `exports`, and `bin` fields
- [ ] Add smoke tests with mocked API responses
- [ ] Document required env vars in both the server’s `README.md` and the root `.env.example`
- [ ] Add the server to the `umt list` registry
- [ ] Update the root `README.md` supported servers table

Look at `servers/hackernews/` or `servers/arxiv/` as examples of clean, no-auth servers to start from, and `servers/github/` for a more complex authenticated integration.

---

## Development Setup

```bash
# Prerequisites: Node.js 18+, pnpm (via corepack)
corepack enable

# Install all dependencies
corepack pnpm install

# Build the full workspace
corepack pnpm build

# Run all type checks
corepack pnpm typecheck

# Run all tests
corepack pnpm test

# Work on a single package
corepack pnpm --filter @universal-mcp-toolkit/server-github build
corepack pnpm --filter @universal-mcp-toolkit/server-github test
```

The workspace uses [Turborepo](https://turbo.build/) for build orchestration, so incremental builds are fast after the first run.

---

## Pull Request Guidelines

- Keep PRs focused. One concern per PR is ideal.
- Reference any related issues with `Closes #123` or `Relates to #123` in the PR description.
- Make sure CI passes before requesting review. The CI pipeline runs build, typecheck, and tests.
- Be responsive to review feedback. PRs with no activity for 30 days may be closed with an invitation to reopen.
- Add yourself to the list of contributors in the PR description if this is your first contribution — we appreciate you.

---

## Commit Message Style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]
[optional footer]
```

Common types:

| Type       | When to use                                          |
| ---------- | ---------------------------------------------------- |
| `feat`     | New server, new CLI command, new tool                |
| `fix`      | Bug fix in a server or CLI                           |
| `docs`     | README, CHANGELOG, inline comments                   |
| `refactor` | Code restructuring without behavior change           |
| `test`     | Adding or updating tests                             |
| `chore`    | Dependency bumps, config changes, CI tweaks          |
| `perf`     | Performance improvement                              |

Examples:

```
feat(server-linear): add bulk issue update tool
fix(core): handle missing env vars gracefully on startup
docs: update quick start to prioritize npx workflow
```

---

## Code Style

- **TypeScript strict mode** is required across the entire workspace. No `any`, no `ts-ignore` without a comment explaining why.
- **Zod** for all tool input and output validation. Don’t use manual type guards where Zod can do the job.
- **pino** for logging. Use structured log fields, not string concatenation.
- **Explicit error handling.** Catch and re-throw with context rather than swallowing errors silently.
- Format your code consistently. The project does not enforce a specific formatter yet, but match the style of the file you’re editing.

---

Thank you for reading this far. Contributions of all kinds are welcome — bug reports, documentation improvements, new servers, and thoughtful feedback all make this project better.
