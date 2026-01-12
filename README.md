# LAN AI Tool Gateway

A local network AI gateway for macOS (Apple Silicon) that provides an OpenAI-compatible proxy and a local MCP tool server with secure command execution and log streaming.

## Features
- OpenAI-compatible endpoints: `GET /v1/models`, `POST /v1/chat/completions` (SSE streaming supported).
- Provider routing: Ollama (HTTP), Gemini CLI, Codex CLI (`codex exec --json`), Dify (OpenAI-compatible or native chat).
- MCP tools: `vscode.open`, `cmd.run`, `logs.stream`.
- Security: API key enforcement, LAN-only CIDR allow list, path & command restrictions, rate limiting.

## Prerequisites
- Node.js 20+
- pnpm 9+
- Ollama (if using `ollama:` models)
- Gemini CLI (`gemini`) if using `gemini:` models
- Codex CLI (`codex`) if using `codex:` models (supports `CODEX_API_KEY`)
- VS Code CLI (`code`) for `vscode.open`

## Setup
```bash
pnpm i
cp .env.example .env
# generate a strong key
openssl rand -hex 32
```
Edit `.env` and `configs/models.yaml` as needed.
Set `CODEX_PROVIDER=cli` to use `codex exec --json`, or `CODEX_PROVIDER=http` with `CODEX_BASE_URL` for a compatible endpoint.
Set `DIFY_API_MODE=openai` for Dify's OpenAI-compatible endpoint, or `DIFY_API_MODE=chat` to use `/v1/chat-messages`.

## Run
```bash
pnpm build
pnpm start:proxy
pnpm start:mcp-http
pnpm mcp
```

## OpenAI-Compatible API
- List models:
```bash
curl -H "Authorization: Bearer $LANAI_API_KEY" http://127.0.0.1:8787/v1/models
```
- Chat completions (stream):
```bash
curl -N -H "Authorization: Bearer $LANAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama:llama3","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8787/v1/chat/completions
```

## MCP Usage
- `lanai-mcp` runs MCP stdio + HTTP control (`/runs/:runId/stream`).
- `cmd.run` returns a `runId`, then call `logs.stream` to get the SSE URL.
Set `MCP_HTTP_BASE_URL` to your LAN IP (for example `http://192.168.1.10:8788`) so remote clients can access log streams.

### Claude Code / OpenCode example
```json
{
  "mcpServers": {
    "lanai": {
      "command": "lanai-mcp",
      "args": [],
      "env": {
        "LANAI_API_KEY": "<your key>",
        "REPO_ROOT": "~/code"
      }
    }
  },
  "openaiCompatible": {
    "baseUrl": "http://<LAN_IP>:8787",
    "apiKey": "<your key>"
  }
}
```
Set your client model to `dify:cc` (or your configured alias) when using the Dify provider.

## Dify Provider
1. Add a model entry in `configs/models.yaml`:
```yaml
- id: dify:cc
  provider: dify
  model: <dify-app-id-or-name>
```
2. Configure environment variables:
```
DIFY_BASE_URL=http://localhost:5001
DIFY_API_KEY=...
DIFY_API_MODE=openai
DIFY_CONTEXT_MODE=stateless
DIFY_USER=lanai
```
3. Restart `pnpm start:proxy`.

### Typical prompt
"Please run tests in ~/code/myrepo using `cmd.run`, stream logs, and summarize failures."

## Launchd (macOS)
```bash
pnpm build
scripts/install-launchd.sh
scripts/status.sh
```
Edit `.env` before installation. Logs go to `~/Library/Logs/lanai/`.

## Security Notes
- Only LAN CIDRs are allowed by default (`LAN_ALLOW_CIDRS`).
- All HTTP endpoints require `Authorization: Bearer $LANAI_API_KEY`.
- `cmd.run` only allows `git`, `pnpm`, `node`, `npm`, `bash -lc`, `python`, `rg` under `REPO_ROOT`.
