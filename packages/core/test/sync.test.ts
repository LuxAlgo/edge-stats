/*
  syncSymbols upper-bound discipline: without an explicit untilMs the default
  must stop short of now so the still-forming last bar (served by tail
  adapters such as hyperliquid) is never ingested — once the watermark moves
  past it, its final version can no longer be re-fetched. A stub adapter
  records the bound it actually receives; the rest of the sync pipeline runs
  for real against an empty data dir.
*/
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Store,
  configSchema,
  registerAdapter,
  syncSymbols,
  type EdgeStatsConfig,
} from "../src/index";
import type { Adapter, FetchRequest } from "../src/adapters/types";

const calls: FetchRequest[] = [];
registerAdapter({
  id: "until-probe",
  title: "test-only probe",
  doc: "records fetch requests, serves no bars",
  requiresEnv: [],
  async *fetchBars(_ctx, req) {
    calls.push(req);
    yield [];
  },
} satisfies Adapter);

let dataDir: string;
let store: Store;
let config: EdgeStatsConfig;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "edge-stats-sync-"));
  mkdirSync(join(dataDir, "calendar"), { recursive: true });
  mkdirSync(join(dataDir, "events"), { recursive: true });
  config = configSchema.parse({
    dataDir,
    symbols: [
      {
        symbol: "PROBE_USD",
        adapter: "until-probe",
        assetClass: "crypto",
      },
    ],
  });
  store = await Store.open(dataDir);
});

afterAll(async () => {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("syncSymbols upper bound", () => {
  it("without opts.untilMs, backs the default off from now by the live-bar guard", async () => {
    const before = Date.now();
    await syncSymbols(store, config);
    const after = Date.now();
    expect(calls.length).toBeGreaterThan(0);
    const untilMs = calls.at(-1)!.untilMs;
    // Guarded: at least 60s shy of now (guard is 120s)…
    expect(untilMs).toBeLessThanOrEqual(after - 60_000);
    // …but a bound, not a stale snapshot: well within the last 5 minutes.
    expect(untilMs).toBeGreaterThan(before - 300_000);
  });

  it("with opts.untilMs, passes the explicit bound through unchanged", async () => {
    const explicit = Date.UTC(2024, 1, 1);
    await syncSymbols(store, config, { untilMs: explicit });
    expect(calls.at(-1)!.untilMs).toBe(explicit);
  });
});
