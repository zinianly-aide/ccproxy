import { OpenAIChatMessage } from "./openai/format";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  approx: boolean;
};

function countAscii(text: string): { ascii: number; nonAscii: number } {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return { ascii, nonAscii };
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const { ascii, nonAscii } = countAscii(text);
  const asciiTokens = Math.ceil(ascii / 4);
  return asciiTokens + nonAscii;
}

export function estimateTokensFromMessages(messages: OpenAIChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokensFromText(msg.content);
  }
  return total;
}

export function estimateTokenUsage(
  messages: OpenAIChatMessage[],
  completionText: string
): TokenUsage {
  const promptTokens = estimateTokensFromMessages(messages);
  const completionTokens = estimateTokensFromText(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    approx: true
  };
}
