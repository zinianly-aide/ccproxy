import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import {
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  sseDelta,
  sseDone,
  toPrompt
} from "../openai/format";

export type ProviderConfig = {
  codexBin?: string;
  model?: string;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  fullAuto?: boolean;
  allowSearch?: boolean;
  apiKey?: string;
  extraArgs?: string[];
  baseUrl?: string;
};

type SSEWrite = (chunk: string) => void;

function isLikelyAgentMessageItem(item: any): boolean {
  const t = item?.type ?? item?.item_type;
  return t === "agent_message" || t === "assistant_message";
}

function extractTextDelta(event: any): string | null {
  const item = event?.item;

  if (
    (event?.type === "item.completed" || event?.type === "item.completed.v1") &&
    isLikelyAgentMessageItem(item)
  ) {
    if (typeof item?.text === "string" && item.text.length) return item.text;
  }

  if (
    (event?.type === "item.updated" ||
      event?.type === "item.progress" ||
      event?.type === "item.delta") &&
    isLikelyAgentMessageItem(item)
  ) {
    const d = event?.delta ?? item?.delta ?? item?.content_delta ?? item?.text_delta;
    if (typeof d === "string" && d.length) return d;
    if (typeof d?.text === "string" && d.text.length) return d.text;
    if (typeof d?.content === "string" && d.content.length) return d.content;
  }

  const maybe = event?.delta;
  if (typeof maybe === "string" && maybe.length) return maybe;
  if (typeof maybe?.text === "string" && maybe.text.length) return maybe.text;

  return null;
}

function resolveCodexModel(req: OpenAIChatCompletionsRequest, override?: string) {
  const rawModel = req.model.startsWith("codex:")
    ? req.model.slice("codex:".length)
    : req.model;
  return override ?? (rawModel && rawModel !== "default" ? rawModel : undefined);
}

export async function handleCodexChatCompletions(opts: {
  req: OpenAIChatCompletionsRequest;
  config: ProviderConfig;
  writeSSE?: SSEWrite;
  requestId?: string;
}): Promise<{ text: string; requestId: string }> {
  const { req, config, writeSSE } = opts;
  const requestId = opts.requestId ?? randomUUID();

  const codexModel = resolveCodexModel(req, config.model);

  const prompt = toPrompt(req.messages as OpenAIChatMessage[]);

  const args: string[] = ["exec", "--json"];

  if (config.cwd) {
    args.push("-C", config.cwd);
  }

  if (config.sandbox) args.push("--sandbox", config.sandbox);
  if (config.fullAuto) args.push("--full-auto");
  if (config.allowSearch) args.push("--search");

  if (codexModel) args.push("--model", codexModel);

  if (config.extraArgs?.length) args.push(...config.extraArgs);

  args.push(prompt);

  const env = { ...process.env };
  if (config.apiKey) {
    env.CODEX_API_KEY = config.apiKey;
  }

  const bin = config.codexBin ?? "codex";
  const child = spawn(bin, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let aggregated = "";
  let sawAnyOutput = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {
    // Intentionally ignore stderr for client output.
  });

  child.stdout.setEncoding("utf8");

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const openaiId = requestId.startsWith("chatcmpl_")
    ? requestId
    : `chatcmpl_${requestId.replace(/-/g, "")}`;
  const modelForResponse = req.model;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const delta = extractTextDelta(event);
    if (delta) {
      sawAnyOutput = true;

      let toEmit = delta;
      if (event?.type === "item.completed" && aggregated.length && delta.startsWith(aggregated)) {
        toEmit = delta.slice(aggregated.length);
      }

      aggregated += toEmit;

      if (req.stream && writeSSE && toEmit) {
        writeSSE(sseDelta(openaiId, modelForResponse, toEmit));
      }
    }
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0 && !sawAnyOutput) {
    throw new Error(
      `codex exec failed (exit=${exitCode}). Check codex login / CODEX_API_KEY / config.`
    );
  }

  if (req.stream && writeSSE) {
    writeSSE(sseDone(openaiId, modelForResponse, "stop"));
  }

  return { text: aggregated, requestId };
}

export async function handleCodexHttpCompletions(opts: {
  req: OpenAIChatCompletionsRequest;
  config: ProviderConfig;
  writeSSE?: SSEWrite;
  requestId?: string;
}): Promise<{ text: string; requestId: string }> {
  const { req, config, writeSSE } = opts;
  const requestId = opts.requestId ?? randomUUID();

  if (!config.baseUrl) {
    throw new Error("CODEX_BASE_URL is required for codex http provider");
  }

  const upstreamModel = resolveCodexModel(req, config.model) ?? req.model;
  const url = new URL("/v1/chat/completions", config.baseUrl).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...req,
      model: upstreamModel
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`codex http error ${response.status}: ${text}`);
  }

  if (req.stream && writeSSE) {
    const decoder = new TextDecoder();
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writeSSE(decoder.decode(value, { stream: true }));
      }
    }
    return { text: "", requestId };
  }

  const data = (await response.json()) as any;
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  return { text: content, requestId };
}
