import { loadConfig, createLogger } from "@lanai/shared";
import { buildServer } from "./server";

async function main() {
  const config = loadConfig();
  const logger = createLogger("proxy");
  const app = buildServer(config);

  try {
    await app.listen({ host: config.proxyHost, port: config.proxyPort });
    logger.info(
      { host: config.proxyHost, port: config.proxyPort },
      "proxy listening"
    );
  } catch (err) {
    logger.error({ err }, "proxy failed to start");
    process.exit(1);
  }
}

main();
