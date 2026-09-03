/*
  The `edgestats serve` API over the demo store's synthetic data: the same
  seeded generator `edgestats init --demo` runs, on a shorter date range so
  the test stays quick. Asserts the session-view endpoint returns one
  session's 1m bars from its partition with the derived levels attached,
  and that it bounds what it will serve.
*/
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  Store,
  configSchema,
  loadPresets,
  syncSymbols,
  type EdgeStatsConfig,
  type QueryResult,
  type SessionBarsResult,
} from "@luxalgo/edge-stats";
import { buildApp } from "../src/commands/serve";
import type { CliContext } from "../src/context";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let dataDir: string;
let store: Store;
let app: Hono;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-serve-"));
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
  cpSync(join(repoRoot, "presets"), join(dataDir, "presets"), { recursive: true });

  // The demo symbols with the demo seeds, over one quarter instead of two years.
  const config: EdgeStatsConfig = configSchema.parse({
    dataDir,
    symbols: [
      {
        symbol: "DEMO_STK",
        adapter: "synthetic",
        assetClass: "equity",
        tf: "1m",
        adapterOptions: { profile: "equity", seed: 42, from: "2024-01-02", to: "2024-03-28" },
      },
      {
        symbol: "DEMO_FUT",
        adapter: "synthetic",
        assetClass: "future",
        tf: "1m",
        adapterOptions: { profile: "future", seed: 1337, from: "2024-01-02", to: "2024-03-28" },
      },
    ],
  });
  store = await Store.open(dataDir);
  await syncSymbols(store, config, { untilMs: Date.UTC(2024, 3, 1) });
  const ctx: CliContext = {
    config,
    configPath: join(dataDir, "edge-stats.config.json"),
    rootDir: dataDir,
    dataDir,
    store,
    presets: loadPresets(join(dataDir, "presets")),
  };
  app = buildApp(ctx);
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

async function postJson<T>(path: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe("GET /api/sessions/:sessionId/bars", () => {
  it("returns one RTH session's 1m bars with the gap levels the report used", async () => {
    const run = await postJson<QueryResult>("/api/query", {
      dsl: "gapFill WHERE gapDir = down",
      symbol: "DEMO_STK",
      sessionsLimit: 5,
    });
    expect(run.status).toBe(200);
    expect(run.body.sessions.length).toBeGreaterThan(0);
    const ref = run.body.sessions[0]!;

    const { status, body } = await getJson<SessionBarsResult>(
      `/api/sessions/${encodeURIComponent(ref.sessionId)}/bars`,
    );
    expect(status).toBe(200);
    expect(body.sessionId).toBe(ref.sessionId);
    expect(body.tradeDate).toBe(ref.tradeDate);
    expect(body).toMatchObject({ symbol: "DEMO_STK", sessionKey: "rth", tf: "1m" });
    expect(body.tz).toBe("America/New_York");

    // A full NYSE RTH day at 1m is 390 bars, strictly inside [start, end), ascending.
    expect(body.bars).toHaveLength(390);
    expect(body.bars[0]?.ts).toBe(body.startTs);
    expect(body.bars.at(-1)!.ts).toBe(body.endTs - 60_000);
    for (let i = 1; i < body.bars.length; i += 1) {
      expect(body.bars[i]!.ts - body.bars[i - 1]!.ts).toBe(60_000);
    }

    // The levels are the ones the query conditioned on; the fill is verifiable in the bars.
    expect(body.levels.gapDir).toBe("down");
    expect(body.levels.prevClose).not.toBeNull();
    expect(body.levels.open).toBe(body.bars[0]?.open);
    expect(body.levels.open!).toBeLessThan(body.levels.prevClose!);
    if (ref.success) {
      expect(body.levels.gapFilled).toBe(true);
      expect(body.times.gapFillMin).toBe(ref.value);
      const fillBar = body.bars[body.times.gapFillMin!];
      expect(fillBar?.high).toBeGreaterThanOrEqual(body.levels.prevClose!);
    } else {
      expect(body.levels.gapFilled).toBe(false);
      expect(body.bars.every((b) => b.high < body.levels.prevClose!)).toBe(true);
    }
    expect(body.levels.openingRanges.map((o) => o.window)).toEqual([5, 10, 15, 30, 60]);
    expect(body.levels.ibWindow).toBe(60);

    // Default context: 30 bars from the prior RTH session (the demo equity has no pre-market).
    expect(body.context.kind).toBe("prior-session");
    expect(body.context.bars).toHaveLength(30);
    expect(body.context.bars.every((b) => b.ts < body.startTs)).toBe(true);
    expect(body.disclaimer).toContain("Not predictions");
  });

  it("marks contiguous pre-session bars as such on a 24h futures store", async () => {
    const run = await postJson<QueryResult>("/api/query", {
      dsl: "gapFill",
      symbol: "DEMO_FUT",
      sessionKey: "rth",
      sessionsLimit: 1,
    });
    const ref = run.body.sessions[0]!;
    const { body } = await getJson<SessionBarsResult>(
      `/api/sessions/${encodeURIComponent(ref.sessionId)}/bars?context=15`,
    );
    // Globex trades right up to the RTH open, so the context is pre-session, not a prior day.
    expect(body.context.kind).toBe("pre-session");
    expect(body.context.bars).toHaveLength(15);
    expect(body.startTs - body.context.bars.at(-1)!.ts).toBe(60_000);
    expect(body.bars.length).toBeGreaterThan(0);
  });

  it("bounds the request: unknown sessions and oversized context are refused", async () => {
    const missing = await getJson<{ error: string; hint: string | null }>(
      `/api/sessions/${encodeURIComponent("DEMO_STK|rth|1999-01-01")}/bars`,
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/unknown session/);
    expect(missing.body.hint).toContain("sessions[].sessionId");

    const run = await postJson<QueryResult>("/api/query", {
      dsl: "closeGreen",
      symbol: "DEMO_STK",
      sessionsLimit: 1,
    });
    const id = encodeURIComponent(run.body.sessions[0]!.sessionId);
    const tooMuch = await getJson<{ error: string }>(`/api/sessions/${id}/bars?context=1000`);
    expect(tooMuch.status).toBe(400);
    const nonsense = await getJson<{ error: string }>(`/api/sessions/${id}/bars?context=abc`);
    expect(nonsense.status).toBe(400);
    const none = await getJson<SessionBarsResult>(`/api/sessions/${id}/bars?context=0`);
    expect(none.status).toBe(200);
    expect(none.body.context).toMatchObject({ kind: "none", bars: [] });
  });
});
