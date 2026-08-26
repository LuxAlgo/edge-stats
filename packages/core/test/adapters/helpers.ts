/*
  Shared scaffolding for the adapter unit tests: a minimal AdapterContext,
  an async-generator flattener, and a global-fetch stub. No test in this
  directory ever touches the network — vendor payloads are committed
  fixtures built in-test.
*/
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { symbolConfigSchema } from "../../src/config";
import type { AdapterContext } from "../../src/adapters/types";
import type { BarRow } from "../../src/store/store";

export function makeCtx(opts: {
  symbol: string;
  adapter: string;
  assetClass?: "equity" | "future" | "crypto" | "forex";
  tf?: string;
  adapterOptions?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  dataDir?: string;
  log?: (msg: string) => void;
}): AdapterContext {
  const symbol = symbolConfigSchema.parse({
    symbol: opts.symbol,
    adapter: opts.adapter,
    assetClass: opts.assetClass ?? "crypto",
    tf: opts.tf ?? "1m",
    adapterOptions: opts.adapterOptions ?? {},
  });
  return {
    symbol,
    dataDir: opts.dataDir ?? tmpdir(),
    env: opts.env ?? {},
    resolveSessions: () => [],
    log: opts.log ?? (() => {}),
  };
}

export async function collect(
  gen: AsyncGenerator<BarRow[]>,
): Promise<{ batches: BarRow[][]; bars: BarRow[] }> {
  const batches: BarRow[][] = [];
  for await (const batch of gen) batches.push(batch);
  return { batches, bars: batches.flat() };
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch for one test; pair with vi.unstubAllGlobals() in afterEach. */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  return { calls };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function bytesResponse(bytes: Uint8Array, status = 200): Response {
  // Copy into a fresh ArrayBuffer so TS/undici agree on the BodyInit type.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Response(buf, { status });
}

/** Assert-the-invariant helper: strictly ascending, inside (sinceMs, untilMs]. */
export function assertWatermarkDiscipline(
  bars: BarRow[],
  sinceMs: number | null,
  untilMs: number,
): void {
  let prev = sinceMs ?? Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    if (bar.ts <= prev) throw new Error(`bars not strictly ascending at ts=${bar.ts}`);
    if (bar.ts > untilMs) throw new Error(`bar ts=${bar.ts} beyond untilMs=${untilMs}`);
    prev = bar.ts;
  }
}
