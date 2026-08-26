/*
  The executor: compiled query → DuckDB → the honest envelope. Every result
  carries N, the Wilson 95% CI, minimum-N guards, a first-half/second-half
  stability split, per-year counts, a recency view, the echoed normalized
  query, and the matching sessions behind the number. No bare percentages.
*/
import type { EdgeStatsConfig, SymbolConfig } from "../config";
import { defaultSessionKey, findSymbol } from "../config";
import { calendarVersionInfo } from "../calendar";
import type { CompileCtx } from "../registry";
import { QueryError, registry } from "../registry";
import type { DistributionSummary, GuardResult, StabilitySplit } from "../stats/stats";
import { applyGuards, distributionFromQuantiles, stabilitySplit, wilson } from "../stats/stats";
import type { Store } from "../store/store";
import { sqlDate, sqlStr } from "../util/sql";
import { asBool, asInt, asNum, asStr, round } from "../util/values";
import { ENGINE_VERSION } from "../version";
import type { QueryAst } from "./ast";
import { queryAstSchema } from "./ast";
import { compileQuery } from "./compile";
import { parseDsl } from "./parser";

export const DISCLAIMER =
  "Historical conditional frequencies with sample sizes. Not predictions, not advice.";

export interface QueryRequest {
  dsl?: string;
  ast?: unknown;
  symbol: string;
  sessionKey?: string;
  since?: string;
  until?: string;
  /** Group results by a groupable registry field instead of one aggregate. */
  groupBy?: string;
  /** How many matching sessions to return for drill-down (default 25). */
  sessionsLimit?: number;
  /** Return the estimate even below the refuse floor (the banner still shows). */
  force?: boolean;
}

export interface SessionRef {
  sessionId: string;
  tradeDate: string;
  success: boolean;
  value: number | null;
}

export interface GroupResult {
  group: string;
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  lowSample: boolean;
}

export interface RecencyView {
  window: number;
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  /** True when the recency CI and the all-history CI do not overlap. */
  diverges: boolean | null;
}

export interface QueryResult {
  engine: { version: string; storeFingerprint: string; calendarVersion: string };
  query: {
    dsl: string;
    ast: QueryAst;
    outcome: string;
    symbol: string;
    sessionKey: string;
    since: string | null;
    until: string | null;
  };
  n: number;
  successes: number;
  estimate: number | null;
  ci95: [number, number] | null;
  guards: GuardResult;
  stability: StabilitySplit | null;
  perYear: { year: number; n: number; successes: number; estimate: number | null }[];
  recency: RecencyView | null;
  distribution: DistributionSummary | null;
  groups: GroupResult[] | null;
  sessions: SessionRef[];
  disclaimer: string;
}

export function compileCtxFor(symbol: SymbolConfig): CompileCtx {
  const orWindows = [...new Set([...symbol.orWindows, symbol.ibWindow])].sort((a, b) => a - b);
  return { orWindows, ibWindow: symbol.ibWindow };
}

export function parseRequestAst(req: QueryRequest): QueryAst {
  if (req.dsl !== undefined && req.ast !== undefined) {
    throw new QueryError("pass either dsl or ast, not both");
  }
  if (req.dsl !== undefined) return parseDsl(req.dsl);
  if (req.ast !== undefined) return queryAstSchema.parse(req.ast);
  throw new QueryError("a query needs a dsl string or an ast");
}

export async function runQuery(
  store: Store,
  config: EdgeStatsConfig,
  req: QueryRequest,
): Promise<QueryResult> {
  const symbol = findSymbol(config, req.symbol);
  const sessionKey = req.sessionKey ?? defaultSessionKey(symbol);
  const ast = parseRequestAst(req);
  const compiled = compileQuery(ast, compileCtxFor(symbol));

  const conditions = [
    `f.symbol = ${sqlStr(symbol.symbol)}`,
    `f.session_key = ${sqlStr(sessionKey)}`,
    "f.complete",
    `(${compiled.eligibilitySql})`,
  ];
  if (req.since) conditions.push(`f.trade_date >= ${sqlDate(req.since)}`);
  if (req.until) conditions.push(`f.trade_date <= ${sqlDate(req.until)}`);
  if (compiled.whereSql) conditions.push(compiled.whereSql);

  const recencyWindow = config.recencyWindow;
  const baseSql = `
    SELECT
      coalesce((${compiled.successSql}), FALSE) AS succ,
      ${compiled.valueSql ? `(${compiled.valueSql})` : "CAST(NULL AS DOUBLE)"} AS val,
      f.session_id AS session_id,
      CAST(f.trade_date AS VARCHAR) AS d,
      f.year AS y,
      row_number() OVER (ORDER BY f.trade_date) AS rn,
      count(*) OVER () AS total
    FROM session_features f
    WHERE ${conditions.join("\n      AND ")}
  `;

  const totals = await store.one(`
    SELECT
      count(*)::INT AS n,
      coalesce(sum(CASE WHEN succ THEN 1 ELSE 0 END), 0)::INT AS k,
      coalesce(sum(CASE WHEN rn * 2 <= total THEN 1 ELSE 0 END), 0)::INT AS n1,
      coalesce(sum(CASE WHEN rn * 2 <= total AND succ THEN 1 ELSE 0 END), 0)::INT AS k1,
      coalesce(sum(CASE WHEN rn * 2 > total THEN 1 ELSE 0 END), 0)::INT AS n2,
      coalesce(sum(CASE WHEN rn * 2 > total AND succ THEN 1 ELSE 0 END), 0)::INT AS k2,
      coalesce(sum(CASE WHEN rn > total - ${recencyWindow} THEN 1 ELSE 0 END), 0)::INT AS nr,
      coalesce(sum(CASE WHEN rn > total - ${recencyWindow} AND succ THEN 1 ELSE 0 END), 0)::INT AS kr,
      count(val)::INT AS valn,
      avg(val) AS vmean,
      to_json(quantile_cont(val, [0.0, 0.25, 0.5, 0.75, 0.9, 1.0])) AS vq
    FROM (${baseSql})
  `);

  const n = asInt(totals?.n) ?? 0;
  const k = asInt(totals?.k) ?? 0;
  const guardResult = applyGuards(n, config.minN);
  const w = wilson(k, n);
  const showEstimate = w !== null && (!guardResult.refused || req.force === true);

  const perYearRows = await store.all(`
    SELECT y AS year, count(*)::INT AS n, sum(CASE WHEN succ THEN 1 ELSE 0 END)::INT AS k
    FROM (${baseSql}) GROUP BY y ORDER BY y
  `);
  const perYear = perYearRows.map((r) => {
    const yn = asInt(r.n) ?? 0;
    const yk = asInt(r.k) ?? 0;
    return {
      year: asInt(r.year) ?? 0,
      n: yn,
      successes: yk,
      estimate: yn > 0 ? round(yk / yn) : null,
    };
  });

  const sessionsLimit = Math.max(0, Math.min(req.sessionsLimit ?? 25, 500));
  const sessionRows =
    sessionsLimit === 0
      ? []
      : await store.all(`
          SELECT session_id, d, succ, val
          FROM (${baseSql}) ORDER BY d DESC LIMIT ${sessionsLimit}
        `);
  const sessions: SessionRef[] = sessionRows.map((r) => ({
    sessionId: asStr(r.session_id) ?? "",
    tradeDate: asStr(r.d) ?? "",
    success: asBool(r.succ) ?? false,
    value: asNum(r.val),
  }));

  let groups: GroupResult[] | null = null;
  if (req.groupBy) {
    const field = registry.fields.get(req.groupBy);
    if (!field || !field.groupable) {
      const groupable = [...registry.fields.values()].filter((f) => f.groupable).map((f) => f.name);
      throw new QueryError(
        `cannot group by '${req.groupBy}'`,
        `groupable fields: ${groupable.join(", ")}`,
      );
    }
    const groupRows = await store.all(`
      SELECT CAST(${field.sql} AS VARCHAR) AS g, count(*)::INT AS n,
             sum(CASE WHEN succ THEN 1 ELSE 0 END)::INT AS k
      FROM (SELECT * FROM (${baseSql})) q
      JOIN session_features f USING (session_id)
      GROUP BY g ORDER BY g
    `);
    groups = groupRows.map((r) => {
      const gn = asInt(r.n) ?? 0;
      const gk = asInt(r.k) ?? 0;
      const gw = wilson(gk, gn);
      return {
        group: asStr(r.g) ?? "NULL",
        n: gn,
        successes: gk,
        estimate: gw ? round(gw.estimate) : null,
        ci95: gw ? [round(gw.lo), round(gw.hi)] : null,
        lowSample: gn < config.minN.warn,
      };
    });
  }

  const n1 = asInt(totals?.n1) ?? 0;
  const k1 = asInt(totals?.k1) ?? 0;
  const n2 = asInt(totals?.n2) ?? 0;
  const k2 = asInt(totals?.k2) ?? 0;
  const stability = n > 0 ? stabilitySplit(n1, k1, n2, k2) : null;

  const nr = asInt(totals?.nr) ?? 0;
  const kr = asInt(totals?.kr) ?? 0;
  let recency: RecencyView | null = null;
  if (n > 0 && nr < n) {
    const rw = wilson(kr, nr);
    let diverges: boolean | null = null;
    if (rw && w) diverges = rw.lo > w.hi || rw.hi < w.lo;
    recency = {
      window: recencyWindow,
      n: nr,
      successes: kr,
      estimate: rw ? round(rw.estimate) : null,
      ci95: rw ? [round(rw.lo), round(rw.hi)] : null,
      diverges,
    };
  }

  let distribution: DistributionSummary | null = null;
  const valn = asInt(totals?.valn) ?? 0;
  if (compiled.valueSql && valn > 0) {
    const vq = asStr(totals?.vq);
    const vmean = asNum(totals?.vmean);
    if (vq && vmean !== null) {
      const parsed = JSON.parse(vq) as (number | null)[];
      if (parsed.every((x): x is number => typeof x === "number")) {
        distribution = distributionFromQuantiles(
          valn,
          round(vmean),
          parsed.map((x) => round(x)),
          compiled.valueUnit ?? "",
        );
      }
    }
  }

  return {
    engine: {
      version: ENGINE_VERSION,
      storeFingerprint: await store.fingerprint(),
      calendarVersion: calendarVersionInfo(store.dataDir).hash,
    },
    query: {
      dsl: compiled.normalizedDsl,
      ast,
      outcome: compiled.outcomeName,
      symbol: symbol.symbol,
      sessionKey,
      since: req.since ?? null,
      until: req.until ?? null,
    },
    n,
    successes: k,
    estimate: showEstimate && w ? round(w.estimate) : null,
    ci95: showEstimate && w ? [round(w.lo), round(w.hi)] : null,
    guards: guardResult,
    stability,
    perYear,
    recency,
    distribution,
    groups,
    sessions,
    disclaimer: DISCLAIMER,
  };
}

export interface SessionDetail {
  sessionId: string;
  features: Record<string, unknown>;
}

/** Drill-down: the full feature rows behind a result's session ids. */
export async function getSessions(store: Store, sessionIds: string[]): Promise<SessionDetail[]> {
  if (sessionIds.length === 0) return [];
  if (sessionIds.length > 500) throw new QueryError("at most 500 sessions per drill-down call");
  const ids = sessionIds.map((s) => sqlStr(s)).join(", ");
  const rows = await store.all(`
    SELECT * REPLACE (CAST(trade_date AS VARCHAR) AS trade_date)
    FROM session_features WHERE session_id IN (${ids}) ORDER BY trade_date
  `);
  return rows.map((r) => {
    const features: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(r)) {
      features[key] = typeof value === "bigint" ? Number(value) : value;
    }
    return { sessionId: asStr(r.session_id) ?? "", features };
  });
}
