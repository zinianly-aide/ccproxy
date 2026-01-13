import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { expandHome } from "./paths";

export type ProviderName = "ollama" | "gemini" | "codex" | "anthropic" | "dify";

export type ModelConfig = {
  id: string;
  provider: ProviderName;
  model: string;
  description?: string;
};

export type AppConfig = {
  apiKey: string;
  allowCidrs: string[];
  rateLimitPerMin: number;
  repoRoot: string;
  corsAllowOrigins: string[];
  logChatContent: boolean;
  logChatContentMaxChars: number;
  logTokenUsage: boolean;
  proxyHost: string;
  proxyPort: number;
  mcpHttpHost: string;
  mcpHttpPort: number;
  mcpHttpBaseUrl: string;
  models: ModelConfig[];
  providers: {
    ollama: { baseUrl: string };
    gemini: { bin: string; args: string[] };
    codex: {
      provider: "http" | "cli";
      baseUrl?: string;
      apiKey?: string;
      bin: string;
      args: string[];
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      fullAuto: boolean;
      allowSearch: boolean;
      cwd?: string;
    };
    dify: {
      baseUrl: string;
      apiKey: string;
      apiMode: "openai" | "chat";
      contextMode: "stateless" | "stateful";
      user: string;
      conversationId?: string;
      inputs: Record<string, unknown>;
    };
    anthropic: {
      apiKey: string;
      baseUrl: string;
    };
  };
};

const DEFAULT_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.1/32"
];

function parseList(input: string | undefined, fallback: string[]): string[] {
  if (!input) return fallback;
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (!input) return fallback;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseDifyApiMode(input: string | undefined): "openai" | "chat" {
  if (!input) return "openai";
  const normalized = input.trim().toLowerCase();
  if (normalized === "chat") return "chat";
  return "openai";
}

function parseDifyContextMode(input: string | undefined): "stateless" | "stateful" {
  if (!input) return "stateless";
  const normalized = input.trim().toLowerCase();
  if (normalized === "stateful") return "stateful";
  return "stateless";
}

function parseJsonObject(
  input: string | undefined,
  fallback: Record<string, unknown> = {}
): Record<string, unknown> {
  if (!input) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("DIFY_INPUTS_JSON must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DIFY_INPUTS_JSON must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveConfigPath(input: string): string {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(process.cwd(), expanded);
}

function loadModelsConfig(configPath: string): ModelConfig[] {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw) as { models?: ModelConfig[] } | null;
  const models = Array.isArray(parsed?.models) ? parsed?.models : [];
  const cleaned = models
    .map((model) => ({
      id: String(model.id || "").trim(),
      provider: model.provider as ProviderName,
      model: String(model.model || "").trim(),
      description: model.description
    }))
    .filter((model) => Boolean(model.id && model.provider && model.model));

  if (!cleaned.length) {
    throw new Error(`No models found in ${configPath}`);
  }

  return cleaned;
}

export function loadConfig(): AppConfig {
  dotenv.config();

  const apiKey = process.env.LANAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("LANAI_API_KEY is required");
  }

  const allowCidrs = parseList(process.env.LAN_ALLOW_CIDRS, DEFAULT_CIDRS);
  const rateLimitPerMin = parseNumber(process.env.RATE_LIMIT_PER_MIN, 120);
  const repoRoot = expandHome(process.env.REPO_ROOT || "~/code");
  const corsAllowOrigins = parseList(process.env.CORS_ALLOW_ORIGINS, []);
  const logChatContent = parseBool(process.env.LOG_CHAT_CONTENT, false);
  const logChatContentMaxChars = parseNumber(process.env.LOG_CHAT_CONTENT_MAX_CHARS, 2000);
  const logTokenUsage = parseBool(process.env.LOG_TOKEN_USAGE, false);

  const proxyHost = process.env.PROXY_HOST || "0.0.0.0";
  const proxyPort = parseNumber(process.env.PROXY_PORT, 8787);
  const mcpHttpHost = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const mcpHttpPort = parseNumber(process.env.MCP_HTTP_PORT, 8788);
  const mcpHttpBaseUrl =
    process.env.MCP_HTTP_BASE_URL || `http://127.0.0.1:${mcpHttpPort}`;

  const modelsPath = resolveConfigPath(
    process.env.MODELS_CONFIG || "./configs/models.yaml"
  );
  const models = loadModelsConfig(modelsPath);

  const codexCwd = process.env.CODEX_CWD
    ? expandHome(process.env.CODEX_CWD)
    : undefined;
  const difyApiMode = parseDifyApiMode(process.env.DIFY_API_MODE);
  const difyContextMode = parseDifyContextMode(process.env.DIFY_CONTEXT_MODE);
  const difyInputs = parseJsonObject(process.env.DIFY_INPUTS_JSON);
  const difyUser = process.env.DIFY_USER || "lanai";
  const difyConversationId = process.env.DIFY_CONVERSATION_ID || undefined;

  return {
    apiKey,
    allowCidrs,
    rateLimitPerMin,
    repoRoot,
    corsAllowOrigins,
    logChatContent,
    logChatContentMaxChars,
    logTokenUsage,
    proxyHost,
    proxyPort,
    mcpHttpHost,
    mcpHttpPort,
    mcpHttpBaseUrl,
    models,
    providers: {
      ollama: {
        baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434"
      },
      gemini: {
        bin: process.env.GEMINI_BIN || "gemini",
        args: splitArgs(process.env.GEMINI_ARGS)
      },
      codex: {
        provider: (process.env.CODEX_PROVIDER as "http" | "cli") || "cli",
        baseUrl: process.env.CODEX_BASE_URL,
        apiKey: process.env.CODEX_API_KEY,
        bin: process.env.CODEX_BIN || "codex",
        args: splitArgs(process.env.CODEX_ARGS),
        sandbox: process.env.CODEX_SANDBOX as
          | "read-only"
          | "workspace-write"
          | "danger-full-access"
          | undefined,
        fullAuto: parseBool(process.env.CODEX_FULL_AUTO, false),
        allowSearch: parseBool(process.env.CODEX_ALLOW_SEARCH, false),
        cwd: codexCwd
      },
      dify: {
        baseUrl: process.env.DIFY_BASE_URL || "",
        apiKey: process.env.DIFY_API_KEY || "",
        apiMode: difyApiMode,
        contextMode: difyContextMode,
        user: difyUser,
        conversationId: difyConversationId,
        inputs: difyInputs
      },
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY || "",
        baseUrl: process.env.ANTHROPIC_BASE_URL || "https://open.bigmodel.cn/api/anthropic"
      }
    }
  };
}
