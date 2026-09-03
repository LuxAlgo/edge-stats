/*
  The store: one DuckDB file per data directory plus hive-partitioned
  parquet for raw bars (symbol / timeframe / year). Everything lives on the
  user's disk; `edgestats export` can hand any of it back out because it
  was never anywhere else.

  Layout under <dataDir>/:
    edge-stats.duckdb   sessions, features, watermarks, events, meta, alerts
    bars/               parquet partitions: symbol=X/tf=1m/year=2024/*.parquet
    calendar/           holiday + half-day calendars this store derives with
    events/             macro event dates (FOMC, CPI, NFP, OPEX, …)
    presets/            the preset catalog this store serves
    tmp/                scratch files for ingest (safe to delete)
*/
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { sqlNum, sqlPath, sqlStr } from "../util/sql";
import { asInt, asNum, asStr } from "../util/values";
import { ENGINE_VERSION } from "../version";

export interface BarRow {
  symbol: string;
  tf: string;
  /** UTC epoch milliseconds of the bar's open. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Underlying futures contract, when applicable (roll detection reads this). */
  contract?: string | null;
}

export interface IngestResult {
  inserted: number;
  skipped: number;
  minTs: number | null;
  maxTs: number | null;
}

function hasParquet(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (name.endsWith(".parquet")) return true;
    }
  }
  return false;
}

export class Store {
  private constructor(
    readonly dataDir: string,
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(dataDir: string): Promise<Store> {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "bars"), { recursive: true });
    mkdirSync(join(dataDir, "tmp"), { recursive: true });
    const instance = await DuckDBInstance.create(join(dataDir, "edge-stats.duckdb"));
    const conn = await instance.connect();
    const store = new Store(dataDir, instance, conn);
    await store.ensureSchema();
    await store.refreshBarsView();
    return store;
  }

  get barsDir(): string {
    return join(this.dataDir, "bars");
  }

  get tmpDir(): string {
    return join(this.dataDir, "tmp");
  }

  /**
   * The parquet globs for (symbol, tf) in the given years, existing
   * partitions only. Reading through these instead of the `bars` view is
   * how a per-session read stays independent of the size of the history.
   */
  barPartitionGlobs(symbol: string, tf: string, years: number[]): string[] {
    const globs: string[] = [];
    for (const year of new Set(years)) {
      const dir = join(this.barsDir, `symbol=${symbol}`, `tf=${tf}`, `year=${year}`);
      if (existsSync(dir)) globs.push(join(dir, "*.parquet"));
    }
    return globs;
  }

  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }

  async all(sql: string): Promise<Record<string, unknown>[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjects() as Record<string, unknown>[];
  }

  async one(sql: string): Promise<Record<string, unknown> | null> {
    const rows = await this.all(sql);
    return rows[0] ?? null;
  }

  private async ensureSchema(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS watermarks (
        symbol VARCHAR, tf VARCHAR, adapter VARCHAR,
        last_ts BIGINT, updated_at TIMESTAMP DEFAULT now(),
        PRIMARY KEY (symbol, tf, adapter)
      );
      CREATE TABLE IF NOT EXISTS events (
        date DATE, event VARCHAR, detail VARCHAR
      );
      CREATE TABLE IF NOT EXISTS meta (
        key VARCHAR PRIMARY KEY, value VARCHAR
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id VARCHAR PRIMARY KEY, fired_at TIMESTAMP, symbol VARCHAR,
        query VARCHAR, snapshot JSON
      );
    `);
    await this.setMeta("engine_version", ENGINE_VERSION);
  }

  async refreshBarsView(): Promise<void> {
    if (hasParquet(this.barsDir)) {
      await this.run(`
        CREATE OR REPLACE VIEW bars AS
        SELECT symbol, tf, ts, open, high, low, close, volume, contract
        FROM read_parquet(${sqlPath(this.barsDir + "/**/*.parquet")},
                          hive_partitioning = true, union_by_name = true)
      `);
    } else {
      await this.run(`
        CREATE OR REPLACE VIEW bars AS
        SELECT CAST(NULL AS VARCHAR) AS symbol, CAST(NULL AS VARCHAR) AS tf,
               CAST(NULL AS BIGINT) AS ts, CAST(NULL AS DOUBLE) AS open,
               CAST(NULL AS DOUBLE) AS high, CAST(NULL AS DOUBLE) AS low,
               CAST(NULL AS DOUBLE) AS close, CAST(NULL AS DOUBLE) AS volume,
               CAST(NULL AS VARCHAR) AS contract
        WHERE FALSE
      `);
    }
  }

  async getWatermark(symbol: string, tf: string, adapter: string): Promise<number | null> {
    const row = await this.one(`
      SELECT last_ts FROM watermarks
      WHERE symbol = ${sqlStr(symbol)} AND tf = ${sqlStr(tf)} AND adapter = ${sqlStr(adapter)}
    `);
    return row ? asNum(row.last_ts) : null;
  }

  async setWatermark(symbol: string, tf: string, adapter: string, lastTs: number): Promise<void> {
    await this.run(`
      INSERT OR REPLACE INTO watermarks (symbol, tf, adapter, last_ts, updated_at)
      VALUES (${sqlStr(symbol)}, ${sqlStr(tf)}, ${sqlStr(adapter)}, ${sqlNum(lastTs)}, now())
    `);
  }

  async clearWatermark(symbol: string, tf: string, adapter: string): Promise<void> {
    await this.run(`
      DELETE FROM watermarks
      WHERE symbol = ${sqlStr(symbol)} AND tf = ${sqlStr(tf)} AND adapter = ${sqlStr(adapter)}
    `);
  }

  /**
   * Append bars to the parquet partitions. Rows at or below `afterTs` are
   * dropped (idempotent incremental sync); the caller owns watermarking.
   */
  async ingestBars(rows: BarRow[], afterTs: number | null): Promise<IngestResult> {
    const fresh = (afterTs === null ? rows : rows.filter((r) => r.ts > afterTs))
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .filter((r, i, arr) => i === 0 || r.ts !== arr[i - 1]?.ts || r.symbol !== arr[i - 1]?.symbol);
    const skipped = rows.length - fresh.length;
    if (fresh.length === 0) return { inserted: 0, skipped, minTs: null, maxTs: null };

    const csvPath = join(this.tmpDir, `ingest-${randomUUID()}.csv`);
    const lines = ["symbol,tf,ts,open,high,low,close,volume,contract"];
    for (const r of fresh) {
      const contract = r.contract ?? "";
      lines.push(
        `${r.symbol},${r.tf},${r.ts},${r.open},${r.high},${r.low},${r.close},${r.volume},${contract}`,
      );
    }
    writeFileSync(csvPath, lines.join("\n"));
    try {
      await this.run(`
        COPY (
          SELECT symbol, tf, ts, open, high, low, close, volume,
                 CASE WHEN contract = '' THEN NULL ELSE contract END AS contract,
                 CAST(strftime(to_timestamp(ts / 1000.0), '%Y') AS INTEGER) AS year
          FROM read_csv(${sqlPath(csvPath)}, header = true, columns = {
            'symbol': 'VARCHAR', 'tf': 'VARCHAR', 'ts': 'BIGINT',
            'open': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE',
            'close': 'DOUBLE', 'volume': 'DOUBLE', 'contract': 'VARCHAR'
          })
        ) TO ${sqlPath(this.barsDir)}
        (FORMAT PARQUET, PARTITION_BY (symbol, tf, year), APPEND)
      `);
    } finally {
      rmSync(csvPath, { force: true });
    }
    await this.refreshBarsView();
    const first = fresh[0];
    const last = fresh[fresh.length - 1];
    return {
      inserted: fresh.length,
      skipped,
      minTs: first ? first.ts : null,
      maxTs: last ? last.ts : null,
    };
  }

  /** Drop all bars for a symbol (full re-sync path). */
  async dropBars(symbol: string, tf: string): Promise<void> {
    const symbolDir = join(this.barsDir, `symbol=${symbol}`, `tf=${tf}`);
    rmSync(symbolDir, { recursive: true, force: true });
    await this.refreshBarsView();
  }

  async replaceEvents(entries: { date: string; event: string; detail?: string }[]): Promise<void> {
    await this.run("DELETE FROM events");
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      if (chunk.length === 0) break;
      const values = chunk
        .map(
          (e) =>
            `(DATE ${sqlStr(e.date)}, ${sqlStr(e.event)}, ${e.detail ? sqlStr(e.detail) : "NULL"})`,
        )
        .join(", ");
      await this.run(`INSERT INTO events (date, event, detail) VALUES ${values}`);
    }
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (${sqlStr(key)}, ${sqlStr(value)})`,
    );
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.one(`SELECT value FROM meta WHERE key = ${sqlStr(key)}`);
    return row ? asStr(row.value) : null;
  }

  /** Deterministic receipt: same store contents ⇒ same fingerprint. */
  async fingerprint(): Promise<string> {
    const bars = await this.one("SELECT count(*) AS c, coalesce(max(ts), 0) AS m FROM bars");
    let features = { c: 0, m: "" };
    try {
      const row = await this.one(
        "SELECT count(*) AS c, coalesce(CAST(max(trade_date) AS VARCHAR), '') AS m FROM session_features",
      );
      if (row) features = { c: asInt(row.c) ?? 0, m: asStr(row.m) ?? "" };
    } catch {
      // features not derived yet
    }
    const calendarVersion = (await this.getMeta("calendar_version")) ?? "";
    const h = createHash("sha256");
    h.update(String(asInt(bars?.c) ?? 0))
      .update(":")
      .update(String(asNum(bars?.m) ?? 0))
      .update(":")
      .update(String(features.c))
      .update(":")
      .update(features.m)
      .update(":")
      .update(calendarVersion)
      .update(":")
      .update(ENGINE_VERSION);
    return h.digest("hex").slice(0, 12);
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}
