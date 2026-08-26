/*
  Streamable-HTTP entry, stateless: each request gets a fresh server +
  transport pair over the shared store context, so the process can restart
  freely. Bind to localhost unless you know exactly why you are exposing
  your own trading database to a network.
*/
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEdgeStatsServer } from "./server";

const PORT = Number(process.env.PORT ?? 3344);
const HOST = process.env.HOST ?? "127.0.0.1";

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  try {
    const server = createEdgeStatsServer();
    const transport = new StreamableHTTPServerTransport({
      // Stateless mode: no session ids, no server-side state between calls.
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[edge-stats-mcp] request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`edge-stats-mcp listening on http://${HOST}:${PORT}/mcp`);
});
