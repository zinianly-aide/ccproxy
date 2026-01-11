import fs from "node:fs";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
  AppConfig,
  createLogger,
  isIpAllowed,
  loadConfig,
  verifyBearer
} from "@lanai/shared";
import { RunStore } from "./runStore";

function errorPayload(message: string, type = "invalid_request_error", code = "bad_request") {
  return { error: { message, type, code } };
}

export function buildHttpControl(config: AppConfig, runStore: RunStore): FastifyInstance {
  const logger = createLogger("mcp-http", { toStderr: true }) as FastifyBaseLogger;
  const app: FastifyInstance = Fastify({ logger });

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

    done();
  });

  app.get("/healthz", async (_req, reply) => {
    reply.send({ ok: true });
  });

  app.get("/runs/:runId", async (req, reply) => {
    const runId = (req.params as { runId: string }).runId;
    const run = runStore.get(runId);
    if (!run) {
      reply.code(404).send(errorPayload("Run not found", "not_found"));
      return;
    }

    reply.send(run);
  });

  app.get("/runs/:runId/stream", async (req, reply) => {
    const runId = (req.params as { runId: string }).runId;
    const run = runStore.get(runId);
    if (!run) {
      reply.code(404).send(errorPayload("Run not found", "not_found"));
      return;
    }

    const fromParam = (req.query as { from?: string }).from;
    const from = fromParam ? Number(fromParam) : 0;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    let currentOffset = Number.isFinite(from) && from >= 0 ? from : 0;

    const sendChunk = (chunk: {
      offset: number;
      nextOffset: number;
      stream: string;
      data: string;
    }) => {
      const payload = {
        offset: chunk.offset,
        nextOffset: chunk.nextOffset,
        stream: chunk.stream,
        chunk: chunk.data
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      currentOffset = chunk.nextOffset;
    };

    try {
      const logPath = runStore.getLogPath(runId);
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        if (currentOffset < stats.size) {
          const stream = fs.createReadStream(logPath, { start: currentOffset });
          for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
            const nextOffset = currentOffset + buffer.length;
            sendChunk({
              offset: currentOffset,
              nextOffset,
              stream: "mixed",
              data: buffer.toString("utf8")
            });
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "failed to read log file");
    }

    const unsubscribe = runStore.subscribe(runId, (chunk) => {
      if (chunk.nextOffset <= currentOffset) return;
      sendChunk(chunk);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };

    reply.raw.on("close", close);
  });

  return app;
}

export async function startHttpControl(config: AppConfig, runStore: RunStore) {
  const app = buildHttpControl(config, runStore);
  await app.listen({ host: config.mcpHttpHost, port: config.mcpHttpPort });
}

if (require.main === module) {
  const config = loadConfig();
  const runStore = new RunStore(config.repoRoot);
  startHttpControl(config, runStore).catch((err) => {
    const logger = createLogger("mcp-http");
    logger.error({ err }, "mcp-http failed to start");
    process.exit(1);
  });
}
