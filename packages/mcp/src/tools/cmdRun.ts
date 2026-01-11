import { spawn } from "node:child_process";
import { resolveRepoDir } from "@lanai/shared";
import { McpTool } from "../mcpServer";
import { RunStore } from "../runStore";

const DEFAULT_TIMEOUT_MS = 900000;
const ALLOWED_COMMANDS = new Set([
  "git",
  "pnpm",
  "node",
  "npm",
  "bash",
  "python",
  "python3",
  "rg"
]);
const DENY_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "SSH_AUTH_SOCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN"
]);
const ALLOW_ENV_KEYS = new Set([
  "NODE_ENV",
  "CI",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "FORCE_COLOR"
]);
const ALLOW_ENV_PREFIXES = ["LANAI_", "TEST_", "CI_"];

function assertSafeCommand(cmd: string): void {
  if (!cmd || !cmd.trim()) {
    throw new Error("cmd is required");
  }
  if (/[;&|><]/.test(cmd) || cmd.includes("\n") || cmd.includes("\r")) {
    throw new Error("Shell operators are not allowed");
  }
  if (cmd.includes("`") || cmd.includes("$(")) {
    throw new Error("Shell expansions are not allowed");
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (/[;&|><]/.test(ch)) {
      throw new Error("Shell operators are not allowed");
    }

    current += ch;
  }

  if (quote) {
    throw new Error("Unclosed quote in command");
  }

  if (current) tokens.push(current);
  return tokens;
}

function validateArgv(argv: string[]): void {
  if (!argv.length) {
    throw new Error("cmd is required");
  }

  const primary = argv[0];
  if (!ALLOWED_COMMANDS.has(primary)) {
    throw new Error(`Command not allowed: ${primary}`);
  }

  if (primary === "bash") {
    if (argv.length !== 3 || argv[1] !== "-lc") {
      throw new Error("Only bash -lc '<cmd>' is allowed");
    }
    const shellCmd = argv[2];
    assertSafeCommand(shellCmd);
    const inner = tokenize(shellCmd);
    if (!inner.length || !ALLOWED_COMMANDS.has(inner[0]) || inner[0] === "bash") {
      throw new Error("bash -lc only allows a single whitelisted command");
    }
  }
}

function sanitizeEnv(input?: Record<string, string>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...process.env };
  if (!input) return output;

  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (DENY_ENV_KEYS.has(key)) continue;
    const allowed =
      ALLOW_ENV_KEYS.has(key) || ALLOW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!allowed) continue;
    output[key] = String(value);
  }

  return output;
}

export function createCmdRunTool(repoRoot: string, runStore: RunStore): McpTool {
  return {
    name: "cmd.run",
    description: "Run a whitelisted command inside a repo under the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo path under repoRoot." },
        cmd: { type: "string", description: "Command to run." },
        timeoutMs: { type: "number" },
        env: { type: "object", additionalProperties: { type: "string" } }
      },
      required: ["repo", "cmd"]
    },
    async handler(input) {
      const repo = typeof input?.repo === "string" ? input.repo.trim() : "";
      const cmd = typeof input?.cmd === "string" ? input.cmd.trim() : "";
      const timeoutMs =
        typeof input?.timeoutMs === "number" && input.timeoutMs > 0
          ? input.timeoutMs
          : DEFAULT_TIMEOUT_MS;

      if (!repo) {
        return {
          content: [{ type: "text", text: "repo is required" }],
          isError: true
        };
      }

      try {
        assertSafeCommand(cmd);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: err?.message || "invalid command" }],
          isError: true
        };
      }

      let argv: string[];
      try {
        argv = tokenize(cmd);
        validateArgv(argv);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: err?.message || "invalid command" }],
          isError: true
        };
      }

      let cwd: string;
      try {
        cwd = resolveRepoDir(repoRoot, repo);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: err?.message || "invalid repo" }],
          isError: true
        };
      }

      const run = runStore.createRun({ repo, cmd, argv, cwd });

      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: sanitizeEnv(input?.env),
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        runStore.append(run.runId, "stdout", chunk);
      });

      child.stderr.on("data", (chunk: string) => {
        runStore.append(run.runId, "stderr", chunk);
      });

      let killed = false;
      let finished = false;
      const timeout = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        runStore.append(run.runId, "stderr", `Command failed to start: ${err.message}\n`);
        runStore.finish(run.runId, null, "killed");
      });

      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        runStore.finish(run.runId, code ?? null, killed ? "killed" : "finished");
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              runId: run.runId,
              exitCode: run.exitCode,
              status: run.status,
              startedAt: run.startedAt,
              endedAt: run.endedAt
            })
          }
        ]
      };
    }
  };
}
