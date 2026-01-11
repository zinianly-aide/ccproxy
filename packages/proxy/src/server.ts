import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  AppConfig,
  createLogger,
  extractBearerToken,
  isIpAllowed,
  RateLimiter,
  verifyBearer
} from "@lanai/shared";
import {
  createChatCompletionResponse,
  OpenAIChatCompletionsRequest
} from "./openai/format";
import { handleOllamaChatCompletions } from "./providers/ollama";
import { handleGeminiChatCompletions } from "./providers/gemini";
import {
  handleCodexChatCompletions,
  handleCodexHttpCompletions
} from "./providers/codex";
import { randomUUID } from "node:crypto";

function errorPayload(message: string, type = "invalid_request_error", code = "bad_request") {
  return { error: { message, type, code } };
}

export function buildServer(config: AppConfig): FastifyInstance {
  const logger = createLogger("proxy") as FastifyBaseLogger;
  const app: FastifyInstance = Fastify({ logger });

  if (config.corsAllowOrigins.length) {
    app.register(cors, {
      origin: (origin, cb) => {
        if (!origin) return cb(null, false);
        const allowed = config.corsAllowOrigins.includes(origin);
        cb(null, allowed);
      }
    });
  }

  const limiter = new RateLimiter(config.rateLimitPerMin, 60_000);

  app.addHook("onRequest", (req, reply, done) => {
    const ip = req.ip;
    if (!isIpAllowed(ip, config.allowCidrs)) {
      reply.code(403).send(errorPayload("IP not allowed", "access_denied", "forbidden"));
      return;
    }

    const authHeader = req.headers.authorization;
    if (!verifyBearer(authHeader, config.apiKey)) {
      reply
        .code(401)
        .send(errorPayload("Invalid API key", "authentication_error", "unauthorized"));
      return;
    }

    const token = extractBearerToken(authHeader) || "anonymous";
    const rate = limiter.allow(token);
    if (!rate.allowed) {
      reply
        .code(429)
        .send(errorPayload("Rate limit exceeded", "rate_limit_error", "too_many_requests"));
      return;
    }

    done();
  });

  app.get("/v1/models", async (_req, reply) => {
    const data = config.models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.provider,
      metadata: {
        provider: model.provider,
        model: model.model,
        description: model.description
      }
    }));

    reply.send({ object: "list", data });
  });

  app.post("/v1/embeddings", async (_req, reply) => {
    reply.code(501).send(errorPayload("Embeddings not configured", "not_supported"));
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const requestId = randomUUID();
    reply.header("x-request-id", requestId);

    const body = req.body as OpenAIChatCompletionsRequest | undefined;
    if (!body || !body.model || !Array.isArray(body.messages)) {
      reply.code(400).send(errorPayload("Invalid request body"));
      return;
    }

    const modelConfig = config.models.find((model) => model.id === body.model);
    if (!modelConfig) {
      reply.code(404).send(errorPayload("Model not found", "not_found", "model_not_found"));
      return;
    }

    const openaiId = `chatcmpl_${requestId.replace(/-/g, "")}`;

    if (body.stream) {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.hijack();

      const writeSSE = (chunk: string) => {
        reply.raw.write(chunk);
      };

      try {
        if (modelConfig.provider === "ollama") {
          await handleOllamaChatCompletions({
            req: body,
            config: config.providers.ollama,
            requestId: openaiId,
            writeSSE
          });
        } else if (modelConfig.provider === "gemini") {
          await handleGeminiChatCompletions({
            req: body,
            config: config.providers.gemini,
            requestId: openaiId,
            writeSSE
          });
        } else if (modelConfig.provider === "codex") {
          if (config.providers.codex.provider === "http") {
            await handleCodexHttpCompletions({
              req: body,
              config: {
                baseUrl: config.providers.codex.baseUrl,
                apiKey: config.providers.codex.apiKey,
                model: modelConfig.model
              },
              requestId: openaiId,
              writeSSE
            });
          } else {
            await handleCodexChatCompletions({
              req: body,
              config: {
                codexBin: config.providers.codex.bin,
                model: modelConfig.model,
                cwd: config.providers.codex.cwd,
                sandbox: config.providers.codex.sandbox,
                fullAuto: config.providers.codex.fullAuto,
                allowSearch: config.providers.codex.allowSearch,
                apiKey: config.providers.codex.apiKey,
                extraArgs: config.providers.codex.args
              },
              requestId: openaiId,
              writeSSE
            });
          }
        } else {
          writeSSE(
            `data: ${JSON.stringify(errorPayload("Unknown provider", "invalid_request"))}\n\n`
          );
          writeSSE("data: [DONE]\n\n");
        }
      } catch (err: any) {
        logger.error({ err }, "streaming error");
        writeSSE(`data: ${JSON.stringify(errorPayload(err?.message || "Provider error"))}\n\n`);
        writeSSE("data: [DONE]\n\n");
      }

      reply.raw.end();
      return;
    }

    try {
      let resultText = "";

      if (modelConfig.provider === "ollama") {
        const result = await handleOllamaChatCompletions({
          req: body,
          config: config.providers.ollama,
          requestId: openaiId
        });
        resultText = result.text;
      } else if (modelConfig.provider === "gemini") {
        const result = await handleGeminiChatCompletions({
          req: body,
          config: config.providers.gemini,
          requestId: openaiId
        });
        resultText = result.text;
      } else if (modelConfig.provider === "codex") {
        if (config.providers.codex.provider === "http") {
          const result = await handleCodexHttpCompletions({
            req: body,
            config: {
              baseUrl: config.providers.codex.baseUrl,
              apiKey: config.providers.codex.apiKey,
              model: modelConfig.model
            },
            requestId: openaiId
          });
          resultText = result.text;
        } else {
          const result = await handleCodexChatCompletions({
            req: body,
            config: {
              codexBin: config.providers.codex.bin,
              model: modelConfig.model,
              cwd: config.providers.codex.cwd,
              sandbox: config.providers.codex.sandbox,
              fullAuto: config.providers.codex.fullAuto,
              allowSearch: config.providers.codex.allowSearch,
              apiKey: config.providers.codex.apiKey,
              extraArgs: config.providers.codex.args
            },
            requestId: openaiId
          });
          resultText = result.text;
        }
      }

      reply.send(createChatCompletionResponse(openaiId, body.model, resultText));
    } catch (err: any) {
      logger.error({ err }, "completion error");
      reply.code(500).send(errorPayload(err?.message || "Provider error", "server_error"));
    }
  });

  return app;
}
