/*
  `edgestats serve`: the local API + dashboard host. Localhost by default;
  there are no accounts and no cloud because there is no server side to any
  of this. The dashboard is a static build served from packages/web/dist
  when present; the API is the same core surface the MCP server exposes.
*/
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import {
  DslSyntaxError,
  QueryError,
  SESSION_BARS_MAX_CONTEXT,
  describeRegistry,
  freshness,
  getSessionBars,
  getSessions,
  listAdapters,
  readLiveState,
  runPreset,
  runQuery,
  type QueryRequest,
} from "@luxalgo/edge-stats";
import { z } from "zod";
import type { CliContext } from "../context";
import { packagedDataRoot } from "../context";

const queryBodySchema = z.object({
  dsl: z.string().optional(),
  ast: z.unknown().optional(),
  symbol: z.string(),
  sessionKey: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  groupBy: z.string().optional(),
  sessionsLimit: z.number().int().optional(),
  force: z.boolean().optional(),
});

const presetBodySchema = z.object({
  presetId: z.string(),
  symbol: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  sessionKey: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  groupBy: z.string().optional(),
  sessionsLimit: z.number().int().optional(),
  force: z.boolean().optional(),
});

const sessionBarsQuerySchema = z.object({
  context: z.coerce.number().int().min(0).max(SESSION_BARS_MAX_CONTEXT).optional(),
});

export function buildApp(ctx: CliContext): Hono {
  const app = new Hono();
  app.use(
    "/api/*",
    cors({
      origin: (origin) =>
        origin?.startsWith("http://localhost") || origin?.startsWith("http://127.0.0.1")
          ? origin
          : undefined,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof QueryError) {
      return c.json({ error: err.message, hint: err.hint ?? null }, 400);
    }
    if (err instanceof DslSyntaxError) {
      return c.json(
        { error: err.message, hint: err.hint ?? null, position: err.pos, length: err.len },
        400,
      );
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "invalid request body", issues: err.issues }, 400);
    }
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  app.get("/api/health", async (c) =>
    c.json({ ok: true, fingerprint: await ctx.store.fingerprint() }),
  );
  app.get("/api/registry", (c) => {
    const kind = c.req.query("kind") as "field" | "predicate" | "outcome" | undefined;
    return c.json({ entries: describeRegistry(kind) });
  });
  app.get("/api/adapters", (c) =>
    c.json({
      adapters: listAdapters().map((a) => ({
        id: a.id,
        title: a.title,
        doc: a.doc,
        requiresEnv: a.requiresEnv,
      })),
    }),
  );
  app.get("/api/symbols", (c) => c.json({ symbols: ctx.config.symbols }));
  app.get("/api/presets", (c) => c.json({ presets: ctx.presets }));
  app.get("/api/freshness", async (c) => c.json(await freshness(ctx.store, ctx.config)));

  app.post("/api/query", async (c) => {
    const body = queryBodySchema.parse(await c.req.json());
    return c.json(await runQuery(ctx.store, ctx.config, body as QueryRequest));
  });
  app.post("/api/preset", async (c) => {
    const body = presetBodySchema.parse(await c.req.json());
    return c.json(await runPreset(ctx.store, ctx.config, ctx.presets, body));
  });
  app.post("/api/sessions", async (c) => {
    const body = z.object({ ids: z.array(z.string()).max(500) }).parse(await c.req.json());
    return c.json({ sessions: await getSessions(ctx.store, body.ids) });
  });

  // Session view: one session's bars at the store's base timeframe plus the
  // levels the engine derived for it. Reads only the session's own
  // (symbol, tf, year) partition, so history size never enters the cost.
  app.get("/api/sessions/:sessionId/bars", async (c) => {
    const { context } = sessionBarsQuerySchema.parse({ context: c.req.query("context") });
    return c.json(
      await getSessionBars(ctx.store, ctx.config, c.req.param("sessionId"), {
        contextBars: context,
      }),
    );
  });

  // Live Board state: the board writes the 'live_state' meta seam every
  // evaluation pass; absent or unparseable reads as { enabled: false }.
  app.get("/api/live/state", async (c) => c.json(await readLiveState(ctx.store)));

  // Static dashboard build, when present.
  const webDist = join(packagedDataRoot(), "packages", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    const indexHtml = readFileSync(join(webDist, "index.html"), "utf8");
    const MIME: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
      ".txt": "text/plain; charset=utf-8",
    };
    const serveFromDist = (c: Context) => {
      const path = normalize(join(webDist, c.req.path));
      if (!path.startsWith(webDist) || !existsSync(path)) return c.notFound();
      const ext = path.slice(path.lastIndexOf("."));
      const body = readFileSync(path);
      return c.body(body, 200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      });
    };
    app.get("/assets/*", serveFromDist);
    app.get("/fonts/*", serveFromDist);
    app.get("*", (c) => c.html(indexHtml));
  } else {
    app.get("/", (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Edge Stats</title>
         <body style="font-family: system-ui; background:#0b0e14; color:#e6e6e6; padding:4rem">
         <h1>Edge Stats</h1>
         <p>The API is up. The dashboard is not built yet. Run
         <code>pnpm --filter @luxalgo/edge-stats-web build</code> and restart, or use the CLI:</p>
         <pre>edgestats query "gapFill WHERE dayOfWeek = Tue" --symbol DEMO_STK</pre>
         <p>API: <a style="color:#7aa2ff" href="/api/health">/api/health</a> ·
         <a style="color:#7aa2ff" href="/api/registry">/api/registry</a> ·
         <a style="color:#7aa2ff" href="/api/presets">/api/presets</a></p></body>`,
      ),
    );
  }
  return app;
}

export function startServer(ctx: CliContext, port: number, host: string): void {
  const app = buildApp(ctx);
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`edge-stats serving on http://${host}:${info.port}`);
    console.log(`  dashboard  http://${host}:${info.port}/`);
    console.log(`  api        http://${host}:${info.port}/api/health`);
  });
}
