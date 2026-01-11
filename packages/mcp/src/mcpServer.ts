import readline from "node:readline";
import { createLogger } from "@lanai/shared";

export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: any) => Promise<ToolCallResult>;
};

type McpServerOptions = {
  tools: McpTool[];
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: any;
};

const PROTOCOL_VERSION = "2024-11-05";

export function startMcpServer(opts: McpServerOptions) {
  const logger = createLogger("mcp", { toStderr: true });
  const tools = opts.tools;
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  const send = (id: string | number | undefined, result: any) => {
    if (id === undefined) return;
    const payload = { jsonrpc: "2.0", id, result };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const sendError = (id: string | number | undefined, code: number, message: string) => {
    if (id === undefined) return;
    const payload = { jsonrpc: "2.0", id, error: { code, message } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const handleRequest = async (msg: JsonRpcRequest) => {
    const method = msg.method;
    if (!method) return;

    if (method === "initialize") {
      send(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "lanai-mcp", version: "0.1.0" }
      });
      return;
    }

    if (method === "tools/list") {
      send(msg.id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = msg.params?.name as string | undefined;
      const args = msg.params?.arguments ?? {};
      const tool = toolName ? toolMap.get(toolName) : undefined;
      if (!tool) {
        sendError(msg.id, -32601, `Unknown tool: ${toolName ?? ""}`);
        return;
      }

      try {
        const result = await tool.handler(args);
        send(msg.id, result);
      } catch (err: any) {
        send(msg.id, {
          content: [{ type: "text", text: err?.message || "Tool error" }],
          isError: true
        });
      }
      return;
    }

    if (method === "initialized") {
      return;
    }

    sendError(msg.id, -32601, `Method not found: ${method}`);
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcRequest | null = null;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      logger.warn({ line: trimmed }, "invalid json from client");
      return;
    }

    void handleRequest(msg);
  });

  rl.on("close", () => {
    logger.info("mcp stdin closed");
  });

  return {
    close: () => rl.close()
  };
}
