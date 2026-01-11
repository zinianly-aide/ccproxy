import { McpTool } from "../mcpServer";
import { RunStore } from "../runStore";
import { AppConfig } from "@lanai/shared";

export function createLogsStreamTool(config: AppConfig, runStore: RunStore): McpTool {
  return {
    name: "logs.stream",
    description: "Return an SSE URL for streaming logs from a run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        from: { type: "number" }
      },
      required: ["runId"]
    },
    async handler(input) {
      const runId = typeof input?.runId === "string" ? input.runId.trim() : "";
      const from = typeof input?.from === "number" && input.from >= 0 ? input.from : 0;

      if (!runId) {
        return {
          content: [{ type: "text", text: "runId is required" }],
          isError: true
        };
      }

      const run = runStore.get(runId);
      if (!run) {
        return {
          content: [{ type: "text", text: "run not found" }],
          isError: true
        };
      }

      const base = config.mcpHttpBaseUrl.replace(/\/$/, "");
      const url = `${base}/runs/${runId}/stream?from=${from}`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ url, runId, from })
          }
        ]
      };
    }
  };
}
