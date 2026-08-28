/*
  MCP veneer test: a real MCP client over InMemoryTransport against the
  real server, on the same golden fixture store as the core engine tests.
  Every asserted count traces to fixtures/golden-sessions/gen-fixture.mjs —
  the veneer must neither change the numbers nor strip the envelope.
*/
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { syncSymbols } from "@luxalgo/edge-stats";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../src/context";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtures = join(repoRoot, "fixtures", "golden-sessions");

const UNTIL = Date.UTC(2024, 1, 1); // fixed upper bound: determinism

let dataDir: string;
let ctx: McpContext;
let server: McpServer;
let client: Client;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-mcp-"));
  mkdirSync(join(dataDir, "calendar"), { recursive: true });
  mkdirSync(join(dataDir, "events"), { recursive: true });
  copyFileSync(
    join(repoRoot, "data", "holidays", "nyse.json"),
    join(dataDir, "calendar", "nyse.json"),
  );
  copyFileSync(
    join(repoRoot, "data", "holidays", "cme.json"),
    join(dataDir, "calendar", "cme.json"),
  );
  copyFileSync(join(repoRoot, "data", "events", "opex.json"), join(dataDir, "events", "opex.json"));
  // The repo preset catalog is what the MCP context serves from <dataDir>/presets.
  cpSync(join(repoRoot, "presets"), join(dataDir, "presets"), { recursive: true });

  writeFileSync(
    join(dataDir, "edge-stats.config.json"),
    JSON.stringify({
      dataDir: ".",
      minN: { warn: 5, refuse: 2 },
      symbols: [
        {
          symbol: "FIX_STK",
          adapter: "csv",
          assetClass: "equity",
          tf: "1h",
          orWindows: [60],
          ibWindow: 60,
          adapterOptions: {
            path: join(fixtures, "fix-stk.csv"),
            tsUnit: "ms",
            mapping: {
              ts: "ts",
              open: "open",
              high: "high",
              low: "low",
              close: "close",
              volume: "volume",
            },
          },
        },
        {
          symbol: "FIX_FUT",
          adapter: "csv",
          assetClass: "future",
          defaultSession: "rth",
          tf: "1h",
          orWindows: [60],
          ibWindow: 60,
          adapterOptions: {
            path: join(fixtures, "fix-fut.csv"),
            tsUnit: "ms",
            mapping: {
              ts: "ts",
              open: "open",
              high: "high",
              low: "low",
              close: "close",
              volume: "volume",
              contract: "contract",
            },
          },
        },
      ],
    }),
  );

  // The context is a lazy per-process singleton keyed off EDGESTATS_DIR:
  // the env must be set before the first getContext() call, so import the
  // module dynamically only now.
  process.env.EDGESTATS_DIR = dataDir;
  const { getContext } = await import("../src/context");
  ctx = await getContext();
  await syncSymbols(ctx.store, ctx.config, { untilMs: UNTIL });

  const { createEdgeStatsServer } = await import("../src/server");
  server = createEdgeStatsServer();
  client = new Client({ name: "edge-stats-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.close();
  await ctx.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface RawToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; payload: T }> {
  const res = (await client.callTool({ name, arguments: args })) as unknown as RawToolResult;
  const text = res.content[0]?.text;
  if (text === undefined) throw new Error(`tool ${name} returned no text content`);
  return { isError: res.isError === true, payload: JSON.parse(text) as T };
}

interface Envelope {
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  guards: { refused: boolean };
  query: { dsl: string; symbol: string };
  sessions: { sessionId: string; tradeDate: string; success: boolean }[];
  disclaimer: string;
  preset?: { id: string; version: number; title: string; params: Record<string, number | string> };
}

interface FieldsPayload {
  entries: {
    name: string;
    kind: string;
    library?: { kind: string; slug: string; url: string }[];
  }[];
}

interface CatalogPayload {
  presets: {
    id: string;
    title: string;
    category: string;
    summary: string;
    params: { name: string; type: string; values?: string[]; default?: unknown; doc: string }[];
    groupBy: string | null;
    deltas: string[];
    library: { kind: string; slug: string; url: string }[];
  }[];
  categories: string[];
}

interface FreshnessPayload {
  symbols: {
    symbol: string;
    tf: string;
    adapter: string;
    lastBar: string | null;
    defaultSession: string;
  }[];
  calendars: { exchange: string; version: string; coverage: { from: string; to: string } }[];
  calendarHash: string;
  engineVersion: string;
  storeFingerprint: string;
}

interface ExportPayload {
  rows: number;
  path: string;
  format: string;
}

interface LivePayload {
  enabled: boolean;
  updatedAt?: string | null;
  setups: unknown[];
  note?: string;
}

interface ErrorPayload {
  error: string;
  hint?: string | null;
}

describe("the edge_* tool surface over a real MCP client", () => {
  it("serves exactly the nine edge_* tools", async () => {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(9);
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      "edge_export",
      "edge_fields",
      "edge_freshness",
      "edge_live",
      "edge_query",
      "edge_report",
      "edge_reports_list",
      "edge_sessions",
      "edge_trades",
    ]);
  });

  it("edge_trades says when no trades are imported, then serves the tags once they are", async () => {
    const before = await call<{ imported: boolean; note?: string }>("edge_trades");
    expect(before.isError).toBe(false);
    expect(before.payload.imported).toBe(false);
    expect(before.payload.note).toContain("edgestats trades import");

    writeFileSync(
      join(dataDir, "events", "trades-traded.json"),
      JSON.stringify({
        event: "TRADED",
        version: "trades-2026-03-05",
        sources: ["test fixture"],
        coverage: { from: "2026-03-02", to: "2026-03-05" },
        dates: ["2026-03-02", "2026-03-03"],
      }),
    );
    const after = await call<{
      imported: boolean;
      events: { event: string; days: number }[];
      use: { example: string };
    }>("edge_trades");
    expect(after.isError).toBe(false);
    expect(after.payload.imported).toBe(true);
    expect(after.payload.events).toEqual([expect.objectContaining({ event: "TRADED", days: 2 })]);
    expect(after.payload.use.example).toContain("eventOccurs('TRADED_WIN')");
    rmSync(join(dataDir, "events", "trades-traded.json"));
  });

  it("edge_query answers with the honest envelope: N, CI, and the normalized query", async () => {
    const { isError, payload } = await call<Envelope>("edge_query", {
      dsl: "gapFill",
      symbol: "FIX_STK",
    });
    expect(isError).toBe(false);
    expect(payload.n).toBe(7);
    expect(payload.successes).toBe(4);
    expect(payload.ci95).not.toBeNull();
    expect(payload.query.dsl).toBe("gapFill");
    expect(payload.disclaimer).toContain("Not predictions");

    const messy = await call<Envelope>("edge_query", {
      dsl: "gapFill   WHERE  gapDir=down",
      symbol: "FIX_STK",
    });
    expect(messy.payload.query.dsl).toBe("gapFill WHERE gapDir = down");
    expect(messy.payload.n).toBe(4);
    expect(messy.payload.successes).toBe(2);
  });

  it("edge_fields documents every outcome, with Library citations where they exist", async () => {
    const { payload } = await call<FieldsPayload>("edge_fields", { kind: "outcome" });
    const gapFill = payload.entries.find((e) => e.name === "gapFill");
    expect(gapFill).toBeDefined();
    expect(gapFill?.kind).toBe("outcome");
    expect(gapFill?.library?.map((l) => l.url)).toContain(
      "https://www.luxalgo.com/library/concept/gap-fill/",
    );
  });

  it("edge_report runs a preset with params and says which preset produced the number", async () => {
    const { isError, payload } = await call<Envelope>("edge_report", {
      preset: "gap-fill",
      symbol: "FIX_STK",
      params: { minGapPct: 0.15 },
    });
    expect(isError).toBe(false);
    expect(payload.n).toBe(5);
    expect(payload.successes).toBe(3);
    expect(payload.ci95).not.toBeNull();
    expect(payload.preset).toMatchObject({
      id: "gap-fill",
      version: 1,
      params: { minGapPct: 0.15 },
    });
    expect(payload.query.dsl).toContain("absGapPct >= 0.15");
  });

  it("edge_report rejects unknown presets and params as tool errors with hints", async () => {
    const unknown = await call<ErrorPayload>("edge_report", {
      preset: "gap-fll",
      symbol: "FIX_STK",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.payload.error).toMatch(/unknown preset/);
    expect(unknown.payload.hint).toContain("gap-fill");

    const badParam = await call<ErrorPayload>("edge_report", {
      preset: "gap-fill",
      symbol: "FIX_STK",
      params: { nope: 1 },
    });
    expect(badParam.isError).toBe(true);
    expect(badParam.payload.error).toMatch(/no param/);
  });

  it("edge_reports_list serves the catalog: params, categories, and Library links", async () => {
    const { payload } = await call<CatalogPayload>("edge_reports_list", {});
    expect(payload.presets.map((p) => p.id)).toContain("gap-fill");
    expect(payload.categories).toContain("gaps");
    expect(payload.categories).toContain("opening-range");

    const gapFill = payload.presets.find((p) => p.id === "gap-fill");
    expect(gapFill?.category).toBe("gaps");
    expect(gapFill?.summary.length).toBeGreaterThan(0);
    expect(gapFill?.params.map((p) => p.name)).toEqual(["minGapPct", "maxGapPct", "dir"]);
    expect(gapFill?.params.find((p) => p.name === "dir")?.values).toEqual(["up", "down"]);
    expect(gapFill?.library.map((l) => l.url)).toContain(
      "https://www.luxalgo.com/library/concept/gap-fill/",
    );
    expect(gapFill?.deltas.length).toBeGreaterThan(0);

    const filtered = await call<CatalogPayload>("edge_reports_list", { category: "gaps" });
    expect(filtered.payload.presets.length).toBeGreaterThan(0);
    expect(filtered.payload.presets.every((p) => p.category === "gaps")).toBe(true);
  });

  it("edge_sessions returns the exact sessions behind a result, by id", async () => {
    const query = await call<Envelope>("edge_query", {
      dsl: "gapFill WHERE gapDir = down",
      symbol: "FIX_STK",
    });
    const ids = query.payload.sessions.map((s) => s.sessionId);
    expect(ids).toHaveLength(4);

    const details = await call<{
      sessions: { sessionId: string; features: Record<string, unknown> }[];
    }>("edge_sessions", { ids });
    expect(details.isError).toBe(false);
    expect(details.payload.sessions).toHaveLength(4);
    expect(details.payload.sessions.map((s) => s.sessionId).sort()).toEqual([...ids].sort());
    expect(details.payload.sessions[0]?.features.symbol).toBe("FIX_STK");
  });

  it("edge_freshness lists the configured symbols with last-bar timestamps and store receipts", async () => {
    const { isError, payload } = await call<FreshnessPayload>("edge_freshness");
    expect(isError).toBe(false);
    expect(payload.symbols.map((s) => s.symbol)).toEqual(["FIX_STK", "FIX_FUT"]);

    const stk = payload.symbols.find((s) => s.symbol === "FIX_STK");
    expect(stk).toMatchObject({ tf: "1h", adapter: "csv", defaultSession: "rth" });
    expect(stk?.lastBar).toMatch(/^2024-01/);

    expect(payload.calendars.length).toBeGreaterThan(0);
    expect(payload.calendarHash.length).toBeGreaterThan(0);
    expect(payload.engineVersion.length).toBeGreaterThan(0);
    expect(payload.storeFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("edge_export writes a CSV into <dataDir>/exports and returns rows and path", async () => {
    const { isError, payload } = await call<ExportPayload>("edge_export", {
      query: "gapFill",
      symbol: "FIX_STK",
      filename: "gaps.csv",
    });
    expect(isError).toBe(false);
    expect(payload.rows).toBe(7);
    expect(payload.format).toBe("csv");
    expect(payload.path).toBe(join(dataDir, "exports", "gaps.csv"));
    expect(existsSync(payload.path)).toBe(true);
    const header = readFileSync(payload.path, "utf8").split("\n")[0] ?? "";
    expect(header).toContain("outcome_success");
  });

  it("edge_export never writes outside the exports folder, whatever the filename", async () => {
    const evil = await call<ExportPayload>("edge_export", {
      query: "gapFill",
      symbol: "FIX_STK",
      filename: "../evil.csv",
    });
    // Sanitized or errored — either way, nothing lands outside exports/.
    if (!evil.isError) {
      expect(evil.payload.path.startsWith(join(dataDir, "exports") + sep)).toBe(true);
      expect(evil.payload.path).toBe(join(dataDir, "exports", "evil.csv"));
      expect(existsSync(evil.payload.path)).toBe(true);
    }
    expect(existsSync(join(dataDir, "evil.csv"))).toBe(false);
    expect(existsSync(resolve(dataDir, "..", "evil.csv"))).toBe(false);

    const absName = `edge-stats-escape-${Date.now()}.csv`;
    const absolute = await call<ExportPayload>("edge_export", {
      query: "gapFill",
      symbol: "FIX_STK",
      filename: `/tmp/${absName}`,
    });
    if (!absolute.isError) {
      expect(absolute.payload.path.startsWith(join(dataDir, "exports") + sep)).toBe(true);
    }
    expect(existsSync(join("/tmp", absName))).toBe(false);
  });

  it("edge_export exports whole tables too, and refuses ambiguous requests", async () => {
    const bars = await call<ExportPayload>("edge_export", {
      table: "bars",
      format: "parquet",
    });
    expect(bars.isError).toBe(false);
    expect(bars.payload.rows).toBe(63 + 28); // every FIX_STK + FIX_FUT fixture bar
    expect(bars.payload.format).toBe("parquet");
    expect(bars.payload.path.endsWith(".parquet")).toBe(true);
    expect(existsSync(bars.payload.path)).toBe(true);

    const both = await call<ErrorPayload>("edge_export", {
      query: "gapFill",
      symbol: "FIX_STK",
      table: "bars",
    });
    expect(both.isError).toBe(true);

    const neither = await call<ErrorPayload>("edge_export", {});
    expect(neither.isError).toBe(true);

    const missingSymbol = await call<ErrorPayload>("edge_export", { query: "gapFill" });
    expect(missingSymbol.isError).toBe(true);
    expect(missingSymbol.payload.error).toContain("symbol");
  });

  it("edge_live is honest about a board that is not running, then serves written state", async () => {
    const off = await call<LivePayload>("edge_live");
    expect(off.isError).toBe(false);
    expect(off.payload.enabled).toBe(false);
    expect(off.payload.setups).toEqual([]);
    expect(off.payload.note).toContain("edgestats live");

    await ctx.store.setMeta(
      "live_state",
      JSON.stringify({ enabled: true, updatedAt: "x", setups: [] }),
    );
    const on = await call<LivePayload>("edge_live");
    expect(on.payload.enabled).toBe(true);
    expect(on.payload.updatedAt).toBe("x");
    expect(on.payload.setups).toEqual([]);

    // Defensive parse: garbage in the seam degrades to the disabled shape.
    await ctx.store.setMeta("live_state", "{not json");
    const bad = await call<LivePayload>("edge_live");
    expect(bad.payload.enabled).toBe(false);
    expect(bad.payload.setups).toEqual([]);
    expect(bad.payload.note).toContain("edgestats live");
  });
});
