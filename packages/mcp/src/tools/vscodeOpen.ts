import { spawn } from "node:child_process";
import { resolveWithinRoot } from "@lanai/shared";
import { McpTool } from "../mcpServer";

export function createVscodeOpenTool(repoRoot: string): McpTool {
  return {
    name: "vscode.open",
    description: "Open a file or folder in VS Code under the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path under repo root." }
      },
      required: ["path"]
    },
    async handler(input) {
      const rawPath = typeof input?.path === "string" ? input.path.trim() : "";
      if (!rawPath) {
        return {
          content: [{ type: "text", text: "path is required" }],
          isError: true
        };
      }

      const match = rawPath.match(/^(.*?)(?::(\d+))?$/);
      const basePath = match?.[1] ?? rawPath;
      const line = match?.[2];

      let resolved: string;
      try {
        resolved = resolveWithinRoot(repoRoot, basePath).path;
      } catch (err: any) {
        return {
          content: [{ type: "text", text: err?.message || "invalid path" }],
          isError: true
        };
      }

      const args = line ? ["-g", `${resolved}:${line}`] : [resolved];
      const child = spawn("code", args, { stdio: "ignore" });
      child.unref();

      return {
        content: [{ type: "text", text: JSON.stringify({ opened: resolved }) }]
      };
    }
  };
}
