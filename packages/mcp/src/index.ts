#!/usr/bin/env node
import { loadConfig, createLogger } from "@lanai/shared";
import { RunStore } from "./runStore";
import { startMcpServer } from "./mcpServer";
import { createVscodeOpenTool } from "./tools/vscodeOpen";
import { createCmdRunTool } from "./tools/cmdRun";
import { createLogsStreamTool } from "./tools/logsStream";
import { createSubagentTool } from "./tools/subagentRun";
import { startHttpControl } from "./httpControl";

async function main() {
  const config = loadConfig();
  const logger = createLogger("mcp", { toStderr: true });
  const runStore = new RunStore(config.repoRoot);

  await startHttpControl(config, runStore);

  const tools = [
    createVscodeOpenTool(config.repoRoot),
    createCmdRunTool(config.repoRoot, runStore),
    createLogsStreamTool(config, runStore),
    createSubagentTool(config, runStore)
  ];

  startMcpServer({ tools });

  process.stderr.write("lanai-mcp ready\n");
  logger.info({ port: config.mcpHttpPort }, "mcp-http listening");
}

main().catch((err) => {
  const logger = createLogger("mcp", { toStderr: true });
  logger.error({ err }, "mcp failed to start");
  process.exit(1);
});
