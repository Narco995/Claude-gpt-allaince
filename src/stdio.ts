import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridge } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./interfaces/mcp.js";

// stdio transport for local MCP clients (Claude Desktop / Claude Code). Logs go to stderr only.
const { service } = createBridge(loadConfig());
await createMcpServer(service, "stdio").connect(new StdioServerTransport());
