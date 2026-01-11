# Repository Guidelines

## Project Structure & Module Organization
- `packages/proxy`: OpenAI-compatible HTTP proxy (Fastify + SSE).
- `packages/mcp`: MCP stdio server + HTTP control plane for log streaming.
- `packages/shared`: Shared config, security utilities, logging, and path helpers.
- `configs/models.yaml`: Model routing configuration.
- `scripts/` + `launchd/`: macOS launchd setup and management.
- `tests/`: unit and lightweight integration tests.

## Build, Test, and Development Commands
- `pnpm build`: compile all packages.
- `pnpm start:proxy`: start the OpenAI-compatible proxy.
- `pnpm start:mcp-http`: start the MCP HTTP control plane only.
- `pnpm mcp`: start the MCP stdio server (also launches HTTP control).
- `pnpm test`: run test suite via `tsx --test`.

## Coding Style & Naming Conventions
- Language: TypeScript (Node.js 20+).
- Indentation: 2 spaces, LF line endings, ASCII-only unless required.
- Prefer explicit types for public APIs and tool inputs/outputs.

## Testing Guidelines
- Tests live in `tests/` and are named `*.test.ts`.
- Use Node’s built-in test runner via `tsx --test`.
- Add coverage for security boundaries and streaming behavior.

## Commit & Pull Request Guidelines
- No enforced commit convention yet; use concise, imperative messages (e.g., `feat: add proxy provider`).
- PRs should include a summary, test notes, and any configuration changes.

## Security & Configuration Tips
- All HTTP endpoints require `Authorization: Bearer $LANAI_API_KEY`.
- Keep secrets out of git; update `.env.example` alongside new config keys.
- Ensure any new commands/tools follow the repoRoot and whitelist rules.
