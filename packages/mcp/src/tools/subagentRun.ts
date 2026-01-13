import { AppConfig, createLogger } from "@lanai/shared";
import { McpTool } from "../mcpServer";

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

export function createSubagentTool(config: AppConfig): McpTool {
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

      try {
        if (protocol === "claude") {
          const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.apiKey}`
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

          const data = await response.json();
          const text = Array.isArray(data?.content)
            ? data.content.map((item: { text?: string }) => item.text).filter(Boolean).join("\n")
            : "";
          const result = {
            protocol,
            model: data?.model || model,
            text,
            usage: data?.usage
          };

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
            "Authorization": `Bearer ${config.apiKey}`
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

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
        const result = {
          protocol,
          model: data?.model || model,
          text,
          usage: data?.usage
        };

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err: any) {
        logger.error({ err }, "subagent.run failed");
        return {
          content: [{ type: "text", text: err?.message || "subagent failed" }],
          isError: true
        };
      }
    }
  };
}
