/*
  Alert replay: every fired alert stored its full evaluation snapshot —
  payload, the complete QueryResult envelope behind the number, the watch
  that fired, and the evaluation instant. `replayAlert` hands it back so a
  notification is never a mystery number: you can always re-open exactly
  what the board saw when it fired.
*/
import { QueryError } from "../registry";
import type { QueryResult } from "../query/execute";
import type { Store } from "../store/store";
import { sqlStr } from "../util/sql";
import { asStr } from "../util/values";
import type { AlertPayload, LiveWatch } from "./types";

/** One row of the alerts table, as listed by `edgestats live alerts`. */
export interface AlertRecord {
  id: string;
  firedAt: string;
  symbol: string;
  query: string;
}

/** The stored evaluation snapshot behind one fired alert. */
export interface AlertSnapshot {
  payload: AlertPayload;
  /** The full honest envelope the estimate came from (N, CI, guards, stability, …). */
  envelope: QueryResult;
  /** The watch configuration that fired. */
  watch: LiveWatch;
  evaluatedAt: string;
}

export interface ListAlertsOptions {
  /** Newest-first row cap (default 50, max 500). */
  limit?: number;
}

export async function listAlerts(
  store: Store,
  opts: ListAlertsOptions = {},
): Promise<AlertRecord[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = await store.all(`
    SELECT id, CAST(fired_at AS VARCHAR) AS fired_at, symbol, query
    FROM alerts ORDER BY fired_at DESC, id LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: asStr(r.id) ?? "",
    firedAt: asStr(r.fired_at) ?? "",
    symbol: asStr(r.symbol) ?? "",
    query: asStr(r.query) ?? "",
  }));
}

/** Load one fired alert's stored snapshot, parsed. */
export async function replayAlert(store: Store, id: string): Promise<AlertSnapshot> {
  const row = await store.one(
    `SELECT CAST(snapshot AS VARCHAR) AS snapshot FROM alerts WHERE id = ${sqlStr(id)}`,
  );
  if (!row) {
    throw new QueryError(
      `no alert with id '${id}'`,
      "list fired alerts with `edgestats live alerts`",
    );
  }
  const raw = asStr(row.snapshot);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { payload?: unknown }).payload !== "object"
  ) {
    throw new QueryError(`alert '${id}' has an unreadable snapshot`);
  }
  return parsed as AlertSnapshot;
}
