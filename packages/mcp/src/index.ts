#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/edge-stats-mcp` runs, pointed at
  a store with EDGESTATS_DIR. Keyless and local: every answer comes off the
  user's own disk. Nothing leaves the machine.
*/
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEdgeStatsServer } from "./server";

const server = createEdgeStatsServer();
const transport = new StdioServerTransport();
await server.connect(transport);
