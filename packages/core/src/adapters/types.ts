import type { SessionWindow } from "../calendar";
import type { SymbolConfig } from "../config";
import type { BarRow } from "../store/store";

export interface AdapterContext {
  symbol: SymbolConfig;
  dataDir: string;
  /** Process env — BYO keys live here and nowhere else. Never logged, never stored. */
  env: Record<string, string | undefined>;
  /** Calendar access for adapters that generate or window their pulls by session. */
  resolveSessions: (sessionKey: string, fromDate: string, toDate: string) => SessionWindow[];
  log: (msg: string) => void;
}

export interface FetchRequest {
  /** Exclusive lower bound (the sync watermark); null = full history. */
  sinceMs: number | null;
  /** Inclusive upper bound. */
  untilMs: number;
}

export interface Adapter {
  id: string;
  title: string;
  doc: string;
  /** Env var names the adapter reads (documented, checked before fetch). */
  requiresEnv: string[];
  fetchBars(ctx: AdapterContext, req: FetchRequest): AsyncGenerator<BarRow[]>;
}

export function requireEnv(ctx: AdapterContext, adapter: Adapter): void {
  const missing = adapter.requiresEnv.filter((k) => !ctx.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `${adapter.id}: missing env ${missing.join(", ")} — export it in your shell; keys stay on your box`,
    );
  }
}
