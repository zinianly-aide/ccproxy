import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
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
import { handleDifyChatCompletions } from "./providers/dify";
import {
  handleAnthropicRequest,
  handleAnthropicStream
} from "./providers/anthropic";
import { protocolFirewall } from "./protocol/firewall";
import { sanitizeMessages } from "./protocol/messageSanitizer";
import { randomUUID } from "node:crypto";
import { estimateTokenUsage, type TokenUsage } from "./token";

function errorPayload(message: string, type = "invalid_request_error", code = "bad_request") {
  return { error: { message, type, code } };
}

type UnhandledEntry = {
  key: string;
  method: string;
  url: string;
  count: number;
  lastSeen: string;
  reason: string;
};

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function truncateLogValue(value: string, maxChars: number): string {
  if (maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...<truncated>`;
}

function formatMessagesForLog(
  messages: Array<{ role: string; content: unknown }>,
  maxChars: number
): Array<{ role: string; content: string; contentType: string; contentLength: number }> {
  return messages.map((msg) => {
    const raw = safeStringify(msg.content);
    return {
      role: msg.role,
      content: truncateLogValue(raw, maxChars),
      contentType: typeof msg.content,
      contentLength: raw.length
    };
  });
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
  const unhandledRoutes = new Map<string, UnhandledEntry>();

  const recordUnhandled = (req: FastifyRequest, reason: string) => {
    const key = `${req.method} ${req.url}`;
    const now = new Date().toISOString();
    const existing = unhandledRoutes.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.reason = reason;
      return;
    }
    unhandledRoutes.set(key, {
      key,
      method: req.method,
      url: req.url,
      count: 1,
      lastSeen: now,
      reason
    });
  };

  const logChatContent = (opts: {
    requestId: string;
    model: string;
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
    label: string;
  }) => {
    if (!config.logChatContent) return;
    const maxChars = config.logChatContentMaxChars;
    logger.info({
      requestId: opts.requestId,
      model: opts.model,
      system: opts.system ? truncateLogValue(safeStringify(opts.system), maxChars) : undefined,
      messages: formatMessagesForLog(opts.messages, maxChars)
    }, opts.label);
  };

  const logChatResponse = (opts: {
    requestId: string;
    model: string;
    content: string;
    label: string;
  }) => {
    if (!config.logChatContent) return;
    const maxChars = config.logChatContentMaxChars;
    logger.info({
      requestId: opts.requestId,
      model: opts.model,
      content: truncateLogValue(opts.content, maxChars),
      contentLength: opts.content.length
    }, opts.label);
  };

  const logTokenUsage = (opts: {
    requestId: string;
    model: string;
    provider?: string;
    stream: boolean;
    usage: TokenUsage;
  }) => {
    if (!config.logTokenUsage) return;
    logger.info({
      requestId: opts.requestId,
      model: opts.model,
      provider: opts.provider,
      stream: opts.stream,
      tokenUsage: opts.usage
    }, "Token usage");
  };

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

  app.get("/__lanai/unhandled", async (_req, reply) => {
    const data = Array.from(unhandledRoutes.values()).sort((a, b) => b.count - a.count);
    reply.send({ total: data.length, data });
  });

  app.post("/v1/embeddings", async (req, reply) => {
    recordUnhandled(req, "not_supported");
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
    logChatContent({
      requestId,
      model: body.model,
      messages: body.messages,
      label: "OpenAI request content"
    });

    if (body.stream) {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.hijack();

      let providerText = "";
      let sseCapturedText = "";
      let sseBuffer = "";
      const shouldParseSse = config.logTokenUsage || config.logChatContent;

      const writeSSE = (chunk: string) => {
        if (shouldParseSse) {
          sseBuffer += chunk;
          let newlineIndex = sseBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = sseBuffer.slice(0, newlineIndex).trim();
            sseBuffer = sseBuffer.slice(newlineIndex + 1);
            newlineIndex = sseBuffer.indexOf("\n");
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content
                ?? parsed?.choices?.[0]?.delta?.text
                ?? parsed?.choices?.[0]?.text
                ?? parsed?.choices?.[0]?.message?.content;
              if (typeof delta === "string" && delta.length) {
                sseCapturedText += delta;
              }
            } catch {
              // Ignore invalid JSON.
            }
          }
        }
        reply.raw.write(chunk);
      };

      try {
        if (modelConfig.provider === "ollama") {
          const result = await handleOllamaChatCompletions({
            req: body,
            config: config.providers.ollama,
            requestId: openaiId,
            writeSSE
          });
          providerText = result.text;
        } else if (modelConfig.provider === "gemini") {
          const result = await handleGeminiChatCompletions({
            req: body,
            config: config.providers.gemini,
            requestId: openaiId,
            writeSSE
          });
          providerText = result.text;
        } else if (modelConfig.provider === "codex") {
          if (config.providers.codex.provider === "http") {
            const result = await handleCodexHttpCompletions({
              req: body,
              config: {
                baseUrl: config.providers.codex.baseUrl,
                apiKey: config.providers.codex.apiKey,
                model: modelConfig.model
              },
              requestId: openaiId,
              writeSSE
            });
            providerText = result.text;
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
              requestId: openaiId,
              writeSSE
            });
            providerText = result.text;
          }
        } else if (modelConfig.provider === "dify") {
          const result = await handleDifyChatCompletions({
            req: body,
            config: {
              ...config.providers.dify,
              model: modelConfig.model
            },
            requestId: openaiId,
            writeSSE
          });
          providerText = result.text;
        } else {
          writeSSE(
            `data: ${JSON.stringify(errorPayload("Unknown provider", "invalid_request"))}\n\n`
          );
          writeSSE("data: [DONE]\n\n");
        }

        const streamedText = sseCapturedText || providerText;
        if (streamedText.length) {
          logChatResponse({
            requestId,
            model: body.model,
            content: streamedText,
            label: "OpenAI response content"
          });
        }

        if (streamedText.length || config.logTokenUsage) {
          const usage = estimateTokenUsage(body.messages, streamedText);
          logTokenUsage({
            requestId,
            model: body.model,
            provider: modelConfig.provider,
            stream: true,
            usage
          });
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
      } else if (modelConfig.provider === "dify") {
        const result = await handleDifyChatCompletions({
          req: body,
          config: {
            ...config.providers.dify,
            model: modelConfig.model
          },
          requestId: openaiId
        });
        resultText = result.text;
      }

      if (resultText.length) {
        logChatResponse({
          requestId,
          model: body.model,
          content: resultText,
          label: "OpenAI response content"
        });
      }

      const usage = estimateTokenUsage(body.messages, resultText);
      logTokenUsage({
        requestId,
        model: body.model,
        provider: modelConfig.provider,
        stream: false,
        usage
      });

      reply.send(createChatCompletionResponse(
        openaiId,
        body.model,
        resultText,
        "stop",
        {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens
        }
      ));
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

    // 🔒 PROTOCOL FIREWALL: Check if this is a Claude protocol request
    const hasAnthropicKey = !!config.providers.anthropic.apiKey;
    const strictMode = process.env.STRICT_CLAUDE === "true";

    const firewallResult = protocolFirewall({
      url: req.url,
      headers: req.headers as Record<string, string | undefined>,
      body
    });

    logger.info({
      requestId,
      url: req.url,
      forcedProvider: firewallResult.forceProvider,
      reason: firewallResult.reason,
      model: body.model,
      strictMode,
      hasAnthropicKey
    }, "Protocol firewall check");

    // STRICT MODE: If Claude protocol detected but no API key, reject immediately
    if (strictMode && firewallResult.forceProvider === "anthropic" && !hasAnthropicKey) {
      logger.error({
        requestId,
        reason: firewallResult.reason
      }, "STRICT MODE: Claude protocol detected but Anthropic API not configured");
      reply.code(503).send(createClaudeErrorResponse(
        "Claude protocol requests require Anthropic API configuration. " +
        "Please set ANTHROPIC_API_KEY or disable STRICT_CLAUDE mode."
      ));
      return;
    }

    // If forced to Anthropic, bypass local model routing
    if (firewallResult.forceProvider === "anthropic") {
      if (!hasAnthropicKey) {
        logger.warn({ requestId }, "Anthropic API key not configured, attempting local routing");
        // Fall through to local model routing (non-strict mode behavior)
      } else {
        logger.info({
          requestId,
          reason: firewallResult.reason
        }, "Forcing route to Anthropic API");

        try {
          const anthropicReq = {
            model: body.model,
            max_tokens: body.max_tokens,
            messages: body.messages,
            system: body.system,
            temperature: body.temperature,
            stream: body.stream || false
          };

          if (body.stream) {
            reply.raw.setHeader("Content-Type", "text/event-stream");
            reply.raw.setHeader("Cache-Control", "no-cache");
            reply.raw.setHeader("Connection", "keep-alive");
            reply.raw.setHeader("X-Accel-Buffering", "no");
            reply.hijack();

            let promptTokens = 0;
            let completionTokens = 0;
            let responseText = "";
            const shouldParse = config.logTokenUsage || config.logChatContent;
            const writeSSE = (chunk: string) => {
              if (shouldParse) {
                const lines = chunk.split("\n");
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const data = line.slice(6).trim();
                  if (!data) continue;
                  try {
                    const parsed = JSON.parse(data);
                    if (config.logTokenUsage) {
                      const usage = parsed?.usage;
                      if (typeof usage?.input_tokens === "number") {
                        promptTokens = usage.input_tokens;
                      }
                      if (typeof usage?.output_tokens === "number") {
                        completionTokens = usage.output_tokens;
                      }
                    }
                    const deltaText = parsed?.delta?.text;
                    if (typeof deltaText === "string") {
                      responseText += deltaText;
                    }
                    const blockText = parsed?.content_block?.text;
                    if (typeof blockText === "string") {
                      responseText += blockText;
                    }
                  } catch {
                    // Ignore invalid JSON.
                  }
                }
              }
              reply.raw.write(chunk);
            };

            await handleAnthropicStream({
              req: anthropicReq,
              config: config.providers.anthropic,
              writeSSE
            });

            if (responseText.length) {
              logChatResponse({
                requestId,
                model: body.model,
                content: responseText,
                label: "Claude response content"
              });
            }
            if (config.logTokenUsage && (promptTokens || completionTokens)) {
              logTokenUsage({
                requestId,
                model: body.model,
                provider: "anthropic",
                stream: true,
                usage: {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                  approx: false
                }
              });
            }

            reply.raw.end();
            return;
          } else {
            const result = await handleAnthropicRequest({
              req: anthropicReq,
              config: config.providers.anthropic
            });
            const responseText = Array.isArray(result.content)
              ? result.content.map((item) => item.text).filter(Boolean).join("\n")
              : "";
            if (responseText.length) {
              logChatResponse({
                requestId,
                model: result.model || body.model,
                content: responseText,
                label: "Claude response content"
              });
            }
            if (config.logTokenUsage && result?.usage) {
              logTokenUsage({
                requestId,
                model: result.model || body.model,
                provider: "anthropic",
                stream: false,
                usage: {
                  promptTokens: result.usage.input_tokens,
                  completionTokens: result.usage.output_tokens,
                  totalTokens: result.usage.input_tokens + result.usage.output_tokens,
                  approx: false
                }
              });
            }
            reply.send(result);
            return;
          }
        } catch (err: any) {
          logger.error({ requestId, err }, "Anthropic request error");
          reply.code(500).send(createClaudeErrorResponse(err?.message || "Anthropic API error"));
          return;
        }
      }
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

    // 🧹 Sanitize messages: Remove incomplete/corrupted messages from history
    const { messages: sanitizedMessages, result: sanitizationResult } = sanitizeMessages(body.messages);
    if (sanitizationResult.cleaned) {
      logger.warn({
        requestId,
        originalCount: body.messages.length,
        sanitizedCount: sanitizedMessages.length,
        warnings: sanitizationResult.warnings
      }, "Sanitized incomplete messages from history");
      // Update body.messages with sanitized version
      body.messages = sanitizedMessages as any;
    }

    logChatContent({
      requestId,
      model: body.model,
      system: body.system,
      messages: body.messages,
      label: "Claude request content"
    });

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

    logger.info({
      requestId,
      provider: modelConfig.provider,
      targetModel: actualModel,
      stream: openaiRequest.stream,
      messageCount: openaiRequest.messages.length,
      maxTokens: openaiRequest.max_tokens
    }, "Sending request to provider");

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
        } else if (modelConfig.provider === "dify") {
          await handleDifyChatCompletions({
            req: openaiRequest,
            config: {
              ...config.providers.dify,
              model: modelConfig.model
            },
            requestId: openaiId,
            writeSSE: convertWriteSSE
          });
        } else {
          writeSSE(createClaudeErrorResponse("Unknown provider"));
        }

        // Send Claude stream end events
        writeSSE(claudeSseContentBlockStop(contentBlockIndex));
        if (buffer.length) {
          logChatResponse({
            requestId,
            model: body.model,
            content: buffer,
            label: "Claude response content"
          });
        }
        const usage = estimateTokenUsage(openaiRequest.messages, buffer);
        writeSSE(claudeSseMessageDelta(usage.completionTokens));
        logTokenUsage({
          requestId,
          model: body.model,
          provider: modelConfig.provider,
          stream: true,
          usage
        });
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
      } else if (modelConfig.provider === "dify") {
        const result = await handleDifyChatCompletions({
          req: openaiRequest,
          config: {
            ...config.providers.dify,
            model: modelConfig.model
          },
          requestId: openaiId
        });
        resultText = result.text;
      }

      const duration = Date.now() - startTime;
      if (resultText.length) {
        logChatResponse({
          requestId,
          model: body.model,
          content: resultText,
          label: "Claude response content"
        });
      }
      const usage = estimateTokenUsage(openaiRequest.messages, resultText);
      const claudeResponse = openaiToClaudeResponse(
        claudeId,
        body.model,
        resultText,
        "stop",
        { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens }
      );

      logger.info({
        requestId,
        provider: modelConfig.provider,
        targetModel: actualModel,
        duration,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        responseLength: resultText.length,
        responsePreview: resultText.substring(0, 200)
      }, "Request completed successfully");

      logTokenUsage({
        requestId,
        model: body.model,
        provider: modelConfig.provider,
        stream: false,
        usage
      });

      reply.send(claudeResponse);
    } catch (err: any) {
      logger.error({ requestId, err }, "Claude completion error");
      reply.code(500).send(createClaudeErrorResponse(err?.message || "Provider error"));
    }
  });

  app.setNotFoundHandler((req, reply) => {
    recordUnhandled(req, "not_found");
    logger.warn({ method: req.method, url: req.url }, "Unhandled route");
    reply.code(404).send(errorPayload("Not found", "not_found", "not_found"));
  });

  return app;
}
