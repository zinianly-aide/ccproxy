// Claude Messages API types
export type ClaudeMessage = {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image" | "document"; source: { type: "base64"; media_type: string; data: string } }
      >;
};

export type ClaudeMessageRequest = {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  stream?: boolean;
};

export type ClaudeContentBlockDelta = {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string };
};

export type ClaudeContentBlockStop = {
  type: "content_block_stop";
  index: number;
};

export type ClaudeMessageStop = {
  type: "message_stop";
};

export type ClaudeMessageDelta = {
  type: "message_delta";
  delta: { stop_reason: "end_turn" | "max_tokens" | "stop_sequence"; stop_tokens: string[] };
  usage: { output_tokens: number };
};

export type ClaudeStreamEvent =
  | ClaudeContentBlockDelta
  | ClaudeContentBlockStop
  | ClaudeMessageStop
  | ClaudeMessageDelta;

export type ClaudeMessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

export type ClaudeErrorResponse = {
  type: "error" | "invalid_request_error";
  error: {
    type: string;
    message: string;
  };
};

import { OpenAIChatMessage } from "../openai/format";

// Convert Claude Messages to OpenAI Chat Completions format
export function claudeToOpenaiMessages(messages: ClaudeMessage[], system?: string): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];

  // Add system message first if provided
  if (system && typeof system === "string" && system.trim()) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      if (text) {
        result.push({ role: "user", content: text });
      }
    } else if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      if (text) {
        result.push({ role: "assistant", content: text });
      }
    }
  }

  return result;
}

// Patterns to filter out from messages (noise that doesn't affect model output)
const NOISE_PATTERNS = [
  /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/gm,
  /^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/gm,
  /^<command-name>\/[\w-]+<\/command-name>[\s\S]*?<\/local-command-stdout>\s*/gm,
];

function extractTextContent(
  content: ClaudeMessage["content"]
): string {
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlocks = content.filter((c) => c.type === "text");
    text = textBlocks.map((c) => c.text).join("\n");
  }

  // Filter out noise patterns to reduce token usage
  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, "");
  }

  return text.trim();
}

// Convert OpenAI response to Claude format
export function openaiToClaudeResponse(
  openaiId: string,
  model: string,
  content: string,
  finishReason: "stop" | "length" = "stop",
  usage?: { inputTokens: number; outputTokens: number }
): ClaudeMessageResponse {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? content.length;
  return {
    id: openaiId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: content }],
    model,
    stop_reason: finishReason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

// Create SSE event for Claude streaming
export function claudeSseEncode(event: ClaudeStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function claudeSseDelta(index: number, text: string): string {
  return claudeSseEncode({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text }
  });
}

export function claudeSseContentBlockStop(index: number): string {
  return claudeSseEncode({
    type: "content_block_stop",
    index
  });
}

export function claudeSseMessageStop(): string {
  return claudeSseEncode({
    type: "message_stop"
  });
}

export function claudeSseMessageDelta(outputTokens = 0): string {
  return claudeSseEncode({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_tokens: [] },
    usage: { output_tokens: outputTokens }
  });
}

export function createClaudeErrorResponse(message: string, type: "error" | "invalid_request_error" = "invalid_request_error"): string {
  const error: ClaudeErrorResponse = {
    type,
    error: {
      type,
      message
    }
  };
  return JSON.stringify(error);
}
