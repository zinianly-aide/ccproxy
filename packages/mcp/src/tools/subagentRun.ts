import { AppConfig, createLogger } from "@lanai/shared";
import { McpTool } from "../mcpServer";
import { RunStore } from "../runStore";

type SubagentProtocol = "claude" | "openai";

type SubagentInput = {
  task?: string;
  model?: string;
  system?: string;
  protocol?: SubagentProtocol;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
};

function normalizeHost(host: string): string {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function baseUrlForProxy(config: AppConfig): string {
  const host = normalizeHost(config.proxyHost);
  const port = config.proxyPort;
  const isIpv6 = host.includes(":") && !host.startsWith("[");
  const wrapped = isIpv6 ? `[${host}]` : host;
  return `http://${wrapped}:${port}`;
}

function resolveDefaultModel(config: AppConfig, protocol: SubagentProtocol): string {
  const fromEnv = process.env.SUBAGENT_MODEL;
  if (fromEnv) return fromEnv;
  if (protocol === "claude") {
    const claudeModel = config.models.find((model) => model.id.startsWith("claude"));
    if (claudeModel) return claudeModel.id;
  }
  return config.models[0]?.id || "";
}

function resolveProtocol(input?: string): SubagentProtocol {
  const raw = (input || process.env.SUBAGENT_PROTOCOL || "claude").toLowerCase();
  return raw === "openai" ? "openai" : "claude";
}

function resolveMaxTokens(input?: number): number {
  if (typeof input === "number" && input > 0) return input;
  const envValue = Number(process.env.SUBAGENT_MAX_TOKENS);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  return 1024;
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...<truncated>`;
}

function buildLogsUrl(config: AppConfig, runId: string): string {
  const base = config.mcpHttpBaseUrl.replace(/\/$/, "");
  return `${base}/runs/${runId}/stream?from=0`;
}

export function createSubagentTool(config: AppConfig, runStore: RunStore): McpTool {
  const logger = createLogger("mcp", { toStderr: true });
  const proxyBaseUrl = baseUrlForProxy(config);

  return {
    name: "subagent.run",
    description: "Run a subagent task via the local proxy and return its result.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task instructions for the subagent." },
        model: { type: "string", description: "Model ID to use." },
        system: { type: "string", description: "Optional system prompt." },
        protocol: { type: "string", enum: ["claude", "openai"] },
        max_tokens: { type: "number" },
        temperature: { type: "number" },
        top_p: { type: "number" }
      },
      required: ["task"]
    },
    async handler(input: SubagentInput) {
      const task = typeof input?.task === "string" ? input.task.trim() : "";
      if (!task) {
        return { content: [{ type: "text", text: "task is required" }], isError: true };
      }

      const protocol = resolveProtocol(input?.protocol);
      const model = (input?.model || resolveDefaultModel(config, protocol)).trim();
      if (!model) {
        return { content: [{ type: "text", text: "model is required" }], isError: true };
      }

      const maxTokens = resolveMaxTokens(input?.max_tokens);
      const payloadBase = {
        model,
        temperature: input?.temperature,
        top_p: input?.top_p
      };

      const run = runStore.createRun({
        repo: "subagent",
        cmd: "subagent.run",
        argv: [protocol, model],
        cwd: config.repoRoot
      });
      const runId = run.runId;
      const logMaxChars = config.logChatContentMaxChars;

      const appendLog = (stream: "stdout" | "stderr", payload: Record<string, unknown>) => {
        const line = JSON.stringify({
          time: new Date().toISOString(),
          runId,
          ...payload
        });
        runStore.append(runId, stream, `${line}\n`);
      };

      appendLog("stdout", {
        event: "subagent.start",
        protocol,
        model,
        maxTokens,
        temperature: input?.temperature,
        top_p: input?.top_p
      });

      if (config.logChatContent) {
        appendLog("stdout", {
          event: "subagent.input",
          task: truncate(task, logMaxChars),
          system: input?.system ? truncate(input.system, logMaxChars) : undefined
        });
      } else {
        appendLog("stdout", {
          event: "subagent.input",
          taskLength: task.length,
          hasSystem: Boolean(input?.system)
        });
      }

      try {
        if (protocol === "claude") {
          const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.apiKey}`,
              "x-subagent-run-id": runId
            },
            body: JSON.stringify({
              ...payloadBase,
              max_tokens: maxTokens,
              system: input?.system,
              messages: [{ role: "user", content: task }]
            })
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`subagent claude error ${response.status}: ${errorText}`);
          }

          const proxyRequestId = response.headers.get("x-request-id") || undefined;
          if (proxyRequestId) {
            appendLog("stdout", {
              event: "subagent.proxy_response",
              requestId: proxyRequestId,
              status: response.status
            });
          }

          const data = await response.json();
          const text = Array.isArray(data?.content)
            ? data.content.map((item: { text?: string }) => item.text).filter(Boolean).join("\n")
            : "";
          const usage = data?.usage;

          if (config.logTokenUsage && usage) {
            appendLog("stdout", { event: "subagent.usage", usage });
          }

          if (config.logChatContent) {
            appendLog("stdout", {
              event: "subagent.result",
              text: truncate(text, logMaxChars),
              textLength: text.length
            });
          } else {
            appendLog("stdout", {
              event: "subagent.result",
              textLength: text.length
            });
          }

          const result = {
            protocol,
            model: data?.model || model,
            text,
            usage,
            runId,
            logsUrl: buildLogsUrl(config, runId),
            proxyRequestId
          };

          runStore.finish(runId, 0, "finished");
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        const messages = [];
        if (input?.system && input.system.trim()) {
          messages.push({ role: "system", content: input.system.trim() });
        }
        messages.push({ role: "user", content: task });

        const response = await fetch(`${proxyBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`,
            "x-subagent-run-id": runId
          },
          body: JSON.stringify({
            ...payloadBase,
            model,
            max_tokens: maxTokens,
            messages
          })
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`subagent openai error ${response.status}: ${errorText}`);
        }

        const proxyRequestId = response.headers.get("x-request-id") || undefined;
        if (proxyRequestId) {
          appendLog("stdout", {
            event: "subagent.proxy_response",
            requestId: proxyRequestId,
            status: response.status
          });
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
        const usage = data?.usage;

        if (config.logTokenUsage && usage) {
          appendLog("stdout", { event: "subagent.usage", usage });
        }

        if (config.logChatContent) {
          appendLog("stdout", {
            event: "subagent.result",
            text: truncate(text, logMaxChars),
            textLength: text.length
          });
        } else {
          appendLog("stdout", {
            event: "subagent.result",
            textLength: text.length
          });
        }

        const result = {
          protocol,
          model: data?.model || model,
          text,
          usage,
          runId,
          logsUrl: buildLogsUrl(config, runId),
          proxyRequestId
        };

        runStore.finish(runId, 0, "finished");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        logger.error({ err }, "subagent.run failed");
        const message = err?.message || "subagent failed";
        appendLog("stderr", { event: "subagent.error", message });
        runStore.finish(runId, 1, "finished");
        return {
          content: [{ type: "text", text: JSON.stringify({
            runId,
            logsUrl: buildLogsUrl(config, runId),
            error: message
          }) }],
          isError: true
        };
      }
    }
  };
}
