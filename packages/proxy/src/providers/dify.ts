import { Readable } from "node:stream";
import {
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  sseDelta,
  sseDone,
  toPrompt
} from "../openai/format";

export type DifyApiMode = "openai" | "chat";
export type DifyContextMode = "stateless" | "stateful";

export type DifyConfig = {
  baseUrl: string;
  apiKey: string;
  apiMode: DifyApiMode;
  contextMode: DifyContextMode;
  user: string;
  conversationId?: string;
  inputs: Record<string, unknown>;
  model?: string;
};

type SSEWrite = (chunk: string) => void;

const conversationByUser = new Map<string, string>();

function resolveDifyUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}${normalizedPath}`;
  }
  return `${trimmed}/v1${normalizedPath}`;
}

function resolveUser(req: OpenAIChatCompletionsRequest, config: DifyConfig): string {
  const user = req.user?.trim() || config.user.trim() || "lanai";
  return user;
}

function lastUserMessage(messages: OpenAIChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }
  return undefined;
}

function buildQuery(req: OpenAIChatCompletionsRequest, config: DifyConfig): string {
  if (config.contextMode === "stateful") {
    return lastUserMessage(req.messages) || toPrompt(req.messages);
  }
  return toPrompt(req.messages);
}

function resolveConversationId(
  user: string,
  req: OpenAIChatCompletionsRequest,
  config: DifyConfig
): string | undefined {
  return req.conversation_id || config.conversationId || conversationByUser.get(user);
}

function rememberConversation(
  user: string,
  conversationId: string | undefined,
  config: DifyConfig
): void {
  if (config.contextMode !== "stateful") return;
  if (!conversationId) return;
  conversationByUser.set(user, conversationId);
}

function ensureConfig(config: DifyConfig): void {
  if (!config.baseUrl) {
    throw new Error("DIFY_BASE_URL is required for dify provider");
  }
  if (!config.apiKey) {
    throw new Error("DIFY_API_KEY is required for dify provider");
  }
}

function openaiRequestId(requestId: string): string {
  return requestId.startsWith("chatcmpl_")
    ? requestId
    : `chatcmpl_${requestId.replace(/-/g, "")}`;
}

async function handleDifyOpenAI(opts: {
  req: OpenAIChatCompletionsRequest;
  config: DifyConfig;
  requestId: string;
  writeSSE?: SSEWrite;
}): Promise<{ text: string }> {
  const { req, config, requestId, writeSSE } = opts;
  ensureConfig(config);

  const url = resolveDifyUrl(config.baseUrl, "/chat/completions");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`
  };

  const { conversation_id: _conversationId, ...rest } = req;
  const payload: OpenAIChatCompletionsRequest = {
    ...rest,
    model: config.model ?? req.model,
    user: req.user || config.user
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`dify openai error ${response.status}: ${text}`);
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
    return { text: "" };
  }

  const data = (await response.json()) as any;
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  return { text: content };
}

async function handleDifyChat(opts: {
  req: OpenAIChatCompletionsRequest;
  config: DifyConfig;
  requestId: string;
  writeSSE?: SSEWrite;
}): Promise<{ text: string }> {
  const { req, config, requestId, writeSSE } = opts;
  ensureConfig(config);

  const user = resolveUser(req, config);
  const conversationId = config.contextMode === "stateful"
    ? resolveConversationId(user, req, config)
    : undefined;
  const query = buildQuery(req, config);
  const url = resolveDifyUrl(config.baseUrl, "/chat-messages");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      inputs: config.inputs ?? {},
      query,
      user,
      response_mode: req.stream ? "streaming" : "blocking",
      conversation_id: conversationId
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`dify chat error ${response.status}: ${text}`);
  }

  if (!req.stream || !writeSSE) {
    const data = (await response.json()) as { answer?: string; conversation_id?: string };
    rememberConversation(user, data?.conversation_id, config);
    return { text: data?.answer ?? "" };
  }

  const openaiId = openaiRequestId(requestId);
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregated = "";
  let doneSent = false;

  const stream = response.body ? Readable.fromWeb(response.body as any) : null;
  if (!stream) {
    writeSSE(sseDone(openaiId, req.model));
    return { text: aggregated };
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!rawLine || !rawLine.startsWith("data:")) continue;
      const data = rawLine.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        doneSent = true;
        writeSSE(sseDone(openaiId, req.model));
        continue;
      }

      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      if (payload?.conversation_id) {
        rememberConversation(user, payload.conversation_id, config);
      }

      if (payload?.event === "error") {
        const message = payload?.message || "Dify error";
        throw new Error(message);
      }

      if (typeof payload?.answer === "string" && payload.answer.length) {
        let delta = payload.answer;
        if (delta.startsWith(aggregated)) {
          delta = delta.slice(aggregated.length);
        }
        if (delta) {
          aggregated += delta;
          writeSSE(sseDelta(openaiId, req.model, delta));
        }
      }

      if (payload?.event === "message_end" && !doneSent) {
        doneSent = true;
        writeSSE(sseDone(openaiId, req.model));
      }
    }
  }

  if (!doneSent) {
    writeSSE(sseDone(openaiId, req.model));
  }

  return { text: aggregated };
}

export async function handleDifyChatCompletions(opts: {
  req: OpenAIChatCompletionsRequest;
  config: DifyConfig;
  requestId: string;
  writeSSE?: SSEWrite;
}): Promise<{ text: string }> {
  if (opts.config.apiMode === "openai") {
    return handleDifyOpenAI(opts);
  }
  return handleDifyChat(opts);
}
