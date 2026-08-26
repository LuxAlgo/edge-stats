import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENGINE_VERSION } from "@luxalgo/edge-stats";
import { registerEdgeTools } from "./lib/tools";

export function createEdgeStatsServer(): McpServer {
  const server = new McpServer({ name: "edge-stats", version: ENGINE_VERSION });
  registerEdgeTools(server);
  return server;
}

export { registerEdgeTools };
