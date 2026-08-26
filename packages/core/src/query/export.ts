/*
  `edgestats export` — CSV/parquet of anything in the store. It's the
  user's disk; the engine's job is to hand the data back out in whatever
  shape the next tool wants.
*/
import { defaultSessionKey, findSymbol, type EdgeStatsConfig } from "../config";
import { QueryError } from "../registry";
import type { Store } from "../store/store";
import { sqlDate, sqlPath, sqlStr } from "../util/sql";
import { compileCtxFor, parseRequestAst, type QueryRequest } from "./execute";
import { compileQuery } from "./compile";

export type ExportFormat = "csv" | "parquet";

function copySuffix(format: ExportFormat): string {
  return format === "csv" ? "(FORMAT CSV, HEADER)" : "(FORMAT PARQUET)";
}

export interface ExportSummary {
  rows: number;
  path: string;
  format: ExportFormat;
}

async function copyOut(
  store: Store,
  selectSql: string,
  outPath: string,
  format: ExportFormat,
): Promise<ExportSummary> {
  const count = await store.one(`SELECT count(*)::INT AS c FROM (${selectSql})`);
  await store.run(`COPY (${selectSql}) TO ${sqlPath(outPath)} ${copySuffix(format)}`);
  const c = count ? Number(count.c ?? 0) : 0;
  return { rows: c, path: outPath, format };
}

/** Export a whole table: bars, session features, or the events calendar. */
export async function exportTable(
  store: Store,
  table: "bars" | "sessions" | "events",
  outPath: string,
  format: ExportFormat,
  symbol?: string,
): Promise<ExportSummary> {
  const where = symbol ? ` WHERE symbol = ${sqlStr(symbol)}` : "";
  const sql =
    table === "bars"
      ? `SELECT * FROM bars${where} ORDER BY symbol, ts`
      : table === "sessions"
        ? `SELECT * FROM session_features${where} ORDER BY symbol, session_key, trade_date`
        : `SELECT * FROM events ORDER BY date, event`;
  return copyOut(store, sql, outPath, format);
}

/** Export the full feature rows matching a query (its eligible + conditioned sessions). */
export async function exportQuery(
  store: Store,
  config: EdgeStatsConfig,
  req: QueryRequest,
  outPath: string,
  format: ExportFormat,
): Promise<ExportSummary> {
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
  const sql = `
    SELECT f.*, coalesce((${compiled.successSql}), FALSE) AS outcome_success
      ${compiled.valueSql ? `, (${compiled.valueSql}) AS outcome_value` : ""}
    FROM session_features f
    WHERE ${conditions.join(" AND ")}
    ORDER BY f.trade_date
  `;
  if (!outPath.endsWith(".csv") && !outPath.endsWith(".parquet")) {
    throw new QueryError("export path must end in .csv or .parquet");
  }
  return copyOut(store, sql, outPath, format);
}
