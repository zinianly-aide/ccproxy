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
import {
  claudeToOpenaiMessages,
  openaiToClaudeResponse,
  claudeSseDelta,
  claudeSseContentBlockStop,
  claudeSseMessageDelta,
  claudeSseMessageStop,
  createClaudeErrorResponse,
  ClaudeMessageRequest
} from "./claude/format";
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

  // Claude Messages API endpoint (compatible with Claude clients)
  app.post("/v1/messages", async (req, reply) => {
    const requestId = randomUUID();
    reply.header("x-request-id", requestId);

    const body = req.body as ClaudeMessageRequest | undefined;
    if (!body || !body.model || !Array.isArray(body.messages) || !body.max_tokens) {
      logger.warn({ requestId, body }, "Invalid request body");
      reply.code(400).send(createClaudeErrorResponse("Invalid request body"));
      return;
    }

    // Log incoming request details
    logger.info({
      requestId,
      model: body.model,
      messageCount: body.messages.length,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      stream: body.stream,
      hasSystem: !!body.system,
      messages: body.messages.map(m => ({
        role: m.role,
        contentLength: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
        contentType: typeof m.content
      }))
    }, "Incoming Claude Messages API request");

    const modelConfig = config.models.find((model) => model.id === body.model);
    if (!modelConfig) {
      logger.warn({ requestId, requestedModel: body.model, availableModels: config.models.map(m => m.id) }, "Model not found");
      reply.code(404).send(createClaudeErrorResponse("Model not found"));
      return;
    }

    logger.info({ requestId, requestedModel: body.model, targetProvider: modelConfig.provider, targetModel: modelConfig.model }, "Model mapping");

    const claudeId = `msg_${requestId.replace(/-/g, "")}`;

    // Convert Claude messages to OpenAI format
    const openaiMessages = claudeToOpenaiMessages(body.messages, body.system);
    logger.debug({
      requestId,
      hasSystem: !!body.system,
      systemLength: body.system ? body.system.length : 0,
      claudeMessages: body.messages.length,
      openaiMessages: openaiMessages.length,
      sampleMessage: openaiMessages[0]
    }, "Message format conversion");

    // Use the mapped model name from config instead of the requested alias
    const actualModel = modelConfig.model;

    // Create OpenAI request format
    const openaiRequest: OpenAIChatCompletionsRequest = {
      model: actualModel,
      messages: openaiMessages,
      stream: body.stream || false,
      temperature: body.temperature,
      max_tokens: body.max_tokens
    };

    logger.info({ requestId, openaiRequest }, "Sending request to provider");

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

      // Create a wrapper to convert OpenAI SSE to Claude SSE
      let buffer = "";
      const contentBlockIndex = 0;

      const convertWriteSSE = (chunk: string) => {
        // Parse OpenAI SSE format and convert to Claude format
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.trim() || !line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              buffer += delta.content;
              writeSSE(claudeSseDelta(contentBlockIndex, delta.content));
            }
          } catch {
            // Skip invalid JSON
          }
        }
      };

      try {
        if (modelConfig.provider === "ollama") {
          await handleOllamaChatCompletions({
            req: openaiRequest,
            config: config.providers.ollama,
            requestId: openaiId,
            writeSSE: convertWriteSSE
          });
        } else if (modelConfig.provider === "gemini") {
          await handleGeminiChatCompletions({
            req: openaiRequest,
            config: config.providers.gemini,
            requestId: openaiId,
            writeSSE: convertWriteSSE
          });
        } else if (modelConfig.provider === "codex") {
          if (config.providers.codex.provider === "http") {
            await handleCodexHttpCompletions({
              req: openaiRequest,
              config: {
                baseUrl: config.providers.codex.baseUrl,
                apiKey: config.providers.codex.apiKey,
                model: modelConfig.model
              },
              requestId: openaiId,
              writeSSE: convertWriteSSE
            });
          } else {
            await handleCodexChatCompletions({
              req: openaiRequest,
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
              writeSSE: convertWriteSSE
            });
          }
        } else {
          writeSSE(createClaudeErrorResponse("Unknown provider"));
        }

        // Send Claude stream end events
        writeSSE(claudeSseContentBlockStop(contentBlockIndex));
        writeSSE(claudeSseMessageDelta());
        writeSSE(claudeSseMessageStop());
      } catch (err: any) {
        logger.error({ err }, "Claude streaming error");
        writeSSE(createClaudeErrorResponse(err?.message || "Provider error"));
        writeSSE(claudeSseMessageStop());
      }

      reply.raw.end();
      return;
    }

    // Non-streaming response
    try {
      let resultText = "";
      const startTime = Date.now();

      if (modelConfig.provider === "ollama") {
        const result = await handleOllamaChatCompletions({
          req: openaiRequest,
          config: config.providers.ollama,
          requestId: openaiId
        });
        resultText = result.text;
      } else if (modelConfig.provider === "gemini") {
        const result = await handleGeminiChatCompletions({
          req: openaiRequest,
          config: config.providers.gemini,
          requestId: openaiId
        });
        resultText = result.text;
      } else if (modelConfig.provider === "codex") {
        if (config.providers.codex.provider === "http") {
          const result = await handleCodexHttpCompletions({
            req: openaiRequest,
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
            req: openaiRequest,
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

      const duration = Date.now() - startTime;
      const claudeResponse = openaiToClaudeResponse(claudeId, body.model, resultText);

      logger.info({
        requestId,
        provider: modelConfig.provider,
        targetModel: actualModel,
        duration,
        responseLength: resultText.length,
        responsePreview: resultText.substring(0, 200)
      }, "Request completed successfully");

      reply.send(claudeResponse);
    } catch (err: any) {
      logger.error({ requestId, err }, "Claude completion error");
      reply.code(500).send(createClaudeErrorResponse(err?.message || "Provider error"));
    }
  });

  return app;
}
