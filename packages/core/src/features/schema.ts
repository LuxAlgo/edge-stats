/*
  session_features schema. Opening-range columns are generated per derived
  window (the union across all configured symbols), so "any OR window" is a
  config entry away — add the window, re-sync, and it is queryable.
*/

export interface ColumnSpec {
  name: string;
  type: string;
}

export const BASE_COLUMNS: ColumnSpec[] = [
  { name: "symbol", type: "VARCHAR" },
  { name: "session_key", type: "VARCHAR" },
  { name: "trade_date", type: "DATE" },
  { name: "session_id", type: "VARCHAR" },
  { name: "start_ts", type: "BIGINT" },
  { name: "end_ts", type: "BIGINT" },
  { name: "is_half_day", type: "BOOLEAN" },
  { name: "is_roll_day", type: "BOOLEAN" },
  { name: "complete", type: "BOOLEAN" },
  { name: "bar_count", type: "INTEGER" },
  { name: "dow", type: "VARCHAR" },
  { name: "month", type: "INTEGER" },
  { name: "year", type: "INTEGER" },
  { name: "open", type: "DOUBLE" },
  { name: "high", type: "DOUBLE" },
  { name: "low", type: "DOUBLE" },
  { name: "close", type: "DOUBLE" },
  { name: "volume", type: "DOUBLE" },
  { name: "range_abs", type: "DOUBLE" },
  { name: "range_pct", type: "DOUBLE" },
  { name: "ret_oc_pct", type: "DOUBLE" },
  { name: "green", type: "BOOLEAN" },
  { name: "high_time_min", type: "INTEGER" },
  { name: "low_time_min", type: "INTEGER" },
  { name: "high_before_low", type: "BOOLEAN" },
  { name: "prev_close", type: "DOUBLE" },
  { name: "prev_high", type: "DOUBLE" },
  { name: "prev_low", type: "DOUBLE" },
  { name: "prev_mid", type: "DOUBLE" },
  { name: "prev_range", type: "DOUBLE" },
  { name: "gap_abs", type: "DOUBLE" },
  { name: "gap_pct", type: "DOUBLE" },
  { name: "abs_gap_pct", type: "DOUBLE" },
  { name: "gap_dir", type: "VARCHAR" },
  { name: "gap_bucket", type: "VARCHAR" },
  { name: "gap_filled", type: "BOOLEAN" },
  { name: "gap_fill_min", type: "INTEGER" },
  { name: "gap_reversed", type: "BOOLEAN" },
  { name: "open_pos_prev_range", type: "DOUBLE" },
  { name: "open_above_prev_high", type: "BOOLEAN" },
  { name: "open_below_prev_low", type: "BOOLEAN" },
  { name: "touched_prev_high", type: "BOOLEAN" },
  { name: "touch_prev_high_min", type: "INTEGER" },
  { name: "touched_prev_low", type: "BOOLEAN" },
  { name: "touch_prev_low_min", type: "INTEGER" },
  { name: "closed_above_prev_high", type: "BOOLEAN" },
  { name: "closed_below_prev_low", type: "BOOLEAN" },
  { name: "inside_day", type: "BOOLEAN" },
  { name: "outside_day", type: "BOOLEAN" },
  { name: "nr4", type: "BOOLEAN" },
  { name: "nr7", type: "BOOLEAN" },
  { name: "bull_engulf", type: "BOOLEAN" },
  { name: "bear_engulf", type: "BOOLEAN" },
  { name: "doji", type: "BOOLEAN" },
  { name: "atr14_pct", type: "DOUBLE" },
  { name: "range_vs_atr", type: "DOUBLE" },
  { name: "vol_vs_avg20", type: "DOUBLE" },
  { name: "prev_green_streak", type: "INTEGER" },
  { name: "prev_red_streak", type: "INTEGER" },
  { name: "prev_day_green", type: "BOOLEAN" },
  { name: "fvg_above", type: "BOOLEAN" },
  { name: "fvg_below", type: "BOOLEAN" },
  { name: "next_green", type: "BOOLEAN" },
  { name: "next_ret_oc_pct", type: "DOUBLE" },
  { name: "next_range_pct", type: "DOUBLE" },
  { name: "next_range_vs_atr", type: "DOUBLE" },
  { name: "prev_inside_day", type: "BOOLEAN" },
  { name: "prev_nr7", type: "BOOLEAN" },
  { name: "prev_doji", type: "BOOLEAN" },
  { name: "ib_break", type: "VARCHAR" },
];

export function orColumns(window: number): ColumnSpec[] {
  const p = `or${window}_`;
  return [
    { name: `${p}high`, type: "DOUBLE" },
    { name: `${p}low`, type: "DOUBLE" },
    { name: `${p}range`, type: "DOUBLE" },
    { name: `${p}first_break`, type: "VARCHAR" },
    { name: `${p}break_min`, type: "INTEGER" },
    { name: `${p}false_break`, type: "BOOLEAN" },
    { name: `${p}broke_both`, type: "BOOLEAN" },
    { name: `${p}ext_up_r`, type: "DOUBLE" },
    { name: `${p}ext_dn_r`, type: "DOUBLE" },
  ];
}

export function featureColumns(windows: number[]): ColumnSpec[] {
  const cols = [...BASE_COLUMNS];
  for (const w of windows) cols.push(...orColumns(w));
  return cols;
}

export function featuresDdl(windows: number[]): string {
  const cols = featureColumns(windows)
    .map((c) => `  ${c.name} ${c.type}`)
    .join(",\n");
  return `CREATE TABLE session_features (\n${cols}\n)`;
}
