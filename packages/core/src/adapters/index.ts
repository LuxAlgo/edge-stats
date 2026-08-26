/*
  Adapter registry. `csv` is the universal importer, `synthetic` the
  zero-key demo path, and the vendor adapters (binance, coinbase, alpaca,
  databento, massive) each pull from one data source with the same
  watermark discipline. One registration point — the CLI, sync, and docs
  all enumerate from this map. See docs/data-sources.md for coverage,
  cost models, and per-vendor config examples.
*/
import type { Adapter } from "./types";
import { alpacaAdapter } from "./alpaca";
import { binanceAdapter } from "./binance";
import { coinbaseAdapter } from "./coinbase";
import { csvAdapter } from "./csv";
import { databentoAdapter } from "./databento";
import { massiveAdapter } from "./massive";
import { syntheticAdapter } from "./synthetic";

export * from "./types";
export { csvAdapter } from "./csv";
export { syntheticAdapter } from "./synthetic";
export { alpacaAdapter } from "./alpaca";
export { binanceAdapter } from "./binance";
export { coinbaseAdapter } from "./coinbase";
export { databentoAdapter } from "./databento";
export { massiveAdapter } from "./massive";

const adapters = new Map<string, Adapter>([
  [csvAdapter.id, csvAdapter],
  [syntheticAdapter.id, syntheticAdapter],
  [binanceAdapter.id, binanceAdapter],
  [coinbaseAdapter.id, coinbaseAdapter],
  [alpacaAdapter.id, alpacaAdapter],
  [databentoAdapter.id, databentoAdapter],
  [massiveAdapter.id, massiveAdapter],
]);

export function registerAdapter(adapter: Adapter): void {
  if (adapters.has(adapter.id)) throw new Error(`adapter '${adapter.id}' already registered`);
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): Adapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`unknown adapter '${id}' — available: ${[...adapters.keys()].join(", ")}`);
  }
  return adapter;
}

export function listAdapters(): Adapter[] {
  return [...adapters.values()];
}
