export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type OpenAIChatCompletionsRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

export type OpenAIChatCompletionChoice = {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | null;
};

export type OpenAIChatCompletionsResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
};

export function toPrompt(messages: OpenAIChatMessage[]): string {
  return messages
    .map((m) => {
      const tag = m.role.toUpperCase();
      return `### ${tag}\n${m.content}\n`;
    })
    .join("\n");
}

export function sseEncode(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function sseDelta(id: string, model: string, content: string): string {
  return sseEncode({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null
      }
    ]
  });
}

export function sseDone(
  id: string,
  model: string,
  finishReason: "stop" | "length" = "stop"
): string {
  return (
    sseEncode({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    }) + "data: [DONE]\n\n"
  );
}

export function createChatCompletionResponse(
  id: string,
  model: string,
  content: string,
  finishReason: "stop" | "length" = "stop"
): OpenAIChatCompletionsResponse {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason
      }
    ]
  };
}
