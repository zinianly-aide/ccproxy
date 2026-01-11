import { Readable } from "node:stream";
import { OpenAIChatCompletionsRequest, sseDelta, sseDone } from "../openai/format";

export type OllamaConfig = {
  baseUrl: string;
};

export async function handleOllamaChatCompletions(opts: {
  req: OpenAIChatCompletionsRequest;
  config: OllamaConfig;
  requestId: string;
  writeSSE?: (chunk: string) => void;
}): Promise<{ text: string }>
{
  const { req, config, writeSSE, requestId } = opts;
  const modelName = req.model.startsWith("ollama:")
    ? req.model.slice("ollama:".length)
    : req.model;
  const url = new URL("/api/chat", config.baseUrl).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      stream: Boolean(req.stream),
      messages: req.messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content
      }))
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  if (!req.stream || !writeSSE) {
    const data = (await response.json()) as {
      message?: { content?: string };
      response?: string;
    };
    const content = data.message?.content ?? data.response ?? "";
    return { text: content };
  }

  const openaiId = requestId.startsWith("chatcmpl_")
    ? requestId
    : `chatcmpl_${requestId.replace(/-/g, "")}`;

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
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line) continue;
      let payload: any;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }

      if (payload?.message?.content || payload?.response) {
        const delta = payload.message?.content ?? payload.response ?? "";
        if (delta) {
          aggregated += delta;
          writeSSE(sseDelta(openaiId, req.model, delta));
        }
      }

      if (payload?.done && !doneSent) {
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
