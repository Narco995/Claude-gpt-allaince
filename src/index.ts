import { createBridge } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, logger } = createBridge(config);
const server = app.listen(config.port, config.host, () => logger.info("bridge listening", { host: config.host, port: config.port, mcp: "/mcp", rest: "/api" }));
const shutdown = (sig: string) => { logger.info("shutting down", { sig }); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
