import { spawn } from "node:child_process";
import { OpenAIChatCompletionsRequest, sseDelta, sseDone, toPrompt } from "../openai/format";

export type GeminiConfig = {
  bin: string;
  args: string[];
};

function hasModelFlag(args: string[]): boolean {
  return args.includes("--model") || args.includes("-m");
}

export async function handleGeminiChatCompletions(opts: {
  req: OpenAIChatCompletionsRequest;
  config: GeminiConfig;
  requestId: string;
  writeSSE?: (chunk: string) => void;
}): Promise<{ text: string }>
{
  const { req, config, requestId, writeSSE } = opts;
  const modelName = req.model.startsWith("gemini:")
    ? req.model.slice("gemini:".length)
    : req.model;
  const prompt = toPrompt(req.messages);
  const args = [...config.args];

  if (modelName && !hasModelFlag(args)) {
    args.push("--model", modelName);
  }

  args.push(prompt);

  const child = spawn(config.bin, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {
    // Intentionally ignore stderr in client response.
  });

  const openaiId = requestId.startsWith("chatcmpl_")
    ? requestId
    : `chatcmpl_${requestId.replace(/-/g, "")}`;

  let aggregated = "";
  let sawOutput = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    sawOutput = true;
    aggregated += chunk;
    if (req.stream && writeSSE) {
      writeSSE(sseDelta(openaiId, req.model, chunk));
    }
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0 && !sawOutput) {
    throw new Error(`gemini CLI failed (exit=${exitCode}). Check GEMINI_BIN.`);
  }

  if (req.stream && writeSSE) {
    writeSSE(sseDone(openaiId, req.model));
  }

  return { text: aggregated };
}
