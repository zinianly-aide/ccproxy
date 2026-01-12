/**
 * Anthropic API Provider
 *
 * Handles requests to Anthropic Messages API (via BigModel proxy).
 * This provider is used exclusively for Claude protocol requests.
 */

export interface AnthropicConfig {
  apiKey: string;
  baseUrl: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image" | "document"; source: { type: "base64"; media_type: string; data: string } }
      >;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  stream?: boolean;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type: string; text?: string };
  message_delta?: { stop_reason: string; stop_tokens: string[] };
  usage?: { output_tokens: number };
}

/**
 * Handle non-streaming Anthropic request
 */
export async function handleAnthropicRequest(opts: {
  req: AnthropicRequest;
  config: AnthropicConfig;
}): Promise<AnthropicMessageResponse> {
  const { req, config } = opts;

  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${error}`);
  }

  return response.json() as Promise<AnthropicMessageResponse>;
}

/**
 * Handle streaming Anthropic request
 */
export async function handleAnthropicStream(opts: {
  req: AnthropicRequest;
  config: AnthropicConfig;
  writeSSE: (chunk: string) => void;
}): Promise<void> {
  const { req, config, writeSSE } = opts;

  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...req, stream: true }),
  });

  if (!response.ok) {
    const error = await response.text();
    writeSSE(`data: ${JSON.stringify({ type: "error", error: { message: error } })}\n\n`);
    return;
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().startsWith("data: ")) {
        writeSSE(line + "\n");
      }
    }
  }
}
