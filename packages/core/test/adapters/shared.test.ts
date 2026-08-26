/*
  The plumbing every vendor adapter leans on: epoch-unit normalization,
  watermark clamping, batch splitting, and the retry/backoff fetch. These
  invariants are what "watermark discipline" means in practice.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BATCH_ROWS,
  clampBars,
  epochStrToMs,
  fetchWithRetry,
  inBatches,
  normalizeEpochToMs,
} from "../../src/adapters/shared";
import type { BarRow } from "../../src/store/store";
import { stubFetch, textResponse } from "./helpers";

const T0 = Date.UTC(2024, 0, 15, 12, 0); // 2024-01-15T12:00Z

function bar(ts: number): BarRow {
  return { symbol: "X", tf: "1m", ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

describe("epoch normalization detects the unit by magnitude", () => {
  it("normalizes seconds, millis, micros, and nanos to the same millisecond", () => {
    expect(normalizeEpochToMs(T0 / 1000)).toBe(T0);
    expect(normalizeEpochToMs(T0)).toBe(T0);
    expect(normalizeEpochToMs(T0 * 1e3)).toBe(T0);
    expect(normalizeEpochToMs(T0 * 1e6)).toBe(T0);
  });

  it("rejects garbage instead of storing it", () => {
    expect(() => normalizeEpochToMs(Number.NaN)).toThrow(/unparseable/);
    expect(() => normalizeEpochToMs(0)).toThrow(/unparseable/);
  });

  it("string parsing stays exact where floats cannot (nanosecond magnitudes)", () => {
    // 2024-02-01T00:00:59.999Z in ns — above Number.MAX_SAFE_INTEGER, so a
    // float round-trip can land 1ms off; BigInt division must not.
    expect(epochStrToMs("1706745659999999999")).toBe(1706745659999);
    expect(epochStrToMs("1706745600000000000")).toBe(1706745600000);
    expect(epochStrToMs(String(T0 * 1e3))).toBe(T0); // microseconds
    expect(epochStrToMs(String(T0))).toBe(T0); // milliseconds
    expect(() => epochStrToMs("not-a-time")).toThrow(/unparseable/);
  });
});

describe("clampBars enforces the watermark contract", () => {
  it("sorts ascending, drops duplicates, keeps only (sinceMs, untilMs]", () => {
    const input = [
      bar(T0 + 120_000),
      bar(T0),
      bar(T0 + 60_000),
      bar(T0 + 60_000),
      bar(T0 + 180_000),
    ];
    const out = clampBars(input, T0, T0 + 120_000);
    expect(out.map((b) => b.ts)).toEqual([T0 + 60_000, T0 + 120_000]);
  });

  it("null watermark means full history (still ascending, still capped at until)", () => {
    const out = clampBars([bar(T0 + 60_000), bar(T0)], null, T0 + 60_000);
    expect(out.map((b) => b.ts)).toEqual([T0, T0 + 60_000]);
  });
});

describe("inBatches splits yields for the sync loop", () => {
  it("never emits a batch above the cap and loses nothing", () => {
    const rows = Array.from({ length: 7 }, (_, i) => bar(T0 + i * 60_000));
    const batches = [...inBatches(rows, 3)];
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toEqual(rows);
    expect(MAX_BATCH_ROWS).toBe(50_000);
  });
});

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries 5xx with backoff and returns the eventual success", async () => {
    let n = 0;
    const { calls } = stubFetch(() => {
      n += 1;
      return n < 3 ? textResponse("boom", 500) : textResponse("ok", 200);
    });
    const res = await fetchWithRetry("https://example.test/x", { what: "test", retries: 3 });
    expect(await res.text()).toBe("ok");
    expect(calls.length).toBe(3);
  });

  it("fails hard on auth errors with the env-var hint — and never retries them", async () => {
    const { calls } = stubFetch(() => textResponse("denied", 401));
    await expect(
      fetchWithRetry("https://example.test/x", { what: "test", authHint: "check FAKE_KEY_NAME" }),
    ).rejects.toThrow(/HTTP 401.*check FAKE_KEY_NAME/);
    expect(calls.length).toBe(1);
  });

  it("hands allowed statuses back to the caller (binance uses 404 as 'not published yet')", async () => {
    stubFetch(() => textResponse("nope", 404));
    const res = await fetchWithRetry("https://example.test/x", {
      what: "test",
      allowStatuses: [404],
    });
    expect(res.status).toBe(404);
  });

  it("gives up after the retry budget with the last error in the message", async () => {
    stubFetch(() => textResponse("busy", 429));
    await expect(
      fetchWithRetry("https://example.test/x", { what: "test", retries: 1 }),
    ).rejects.toThrow(/giving up after 2 attempts.*HTTP 429/);
  });

  it("throws a helpful error on other 4xx without retrying", async () => {
    const { calls } = stubFetch(() => textResponse("Invalid symbol.", 400));
    await expect(fetchWithRetry("https://example.test/x", { what: "test" })).rejects.toThrow(
      /HTTP 400.*Invalid symbol/,
    );
    expect(calls.length).toBe(1);
  });
});
