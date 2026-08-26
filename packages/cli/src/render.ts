/*
  Terminal rendering. The honesty rules apply here the same as everywhere:
  the estimate never prints without N and the CI; guards render as loud
  banners; the disclaimer prints where results render.
*/
import pc from "picocolors";
import type { PresetRunResult, QueryResult } from "@luxalgo/edge-stats";

export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined) return "—";
  return `${(100 * x).toFixed(digits)}%`;
}

function ciText(ci: [number, number] | null): string {
  if (!ci) return "";
  return `95% CI [${pct(ci[0])}, ${pct(ci[1])}]`;
}

export function renderResult(result: QueryResult | PresetRunResult): string {
  const lines: string[] = [];
  const preset = "preset" in result ? result.preset : null;
  const header = preset
    ? `${pc.bold(preset.title)} ${pc.dim(`(${preset.id} v${preset.version})`)}`
    : pc.bold(result.query.dsl);
  const range = [result.query.since ?? "start", result.query.until ?? "latest"].join(" → ");
  lines.push(`${header}`);
  if (preset) lines.push(pc.dim(`  query: ${result.query.dsl}`));
  lines.push(pc.dim(`  ${result.query.symbol} · ${result.query.sessionKey} · ${range}`));
  lines.push("");

  if (result.guards.refused && result.estimate === null) {
    lines.push(
      pc.red(
        `  REFUSED: only ${result.n} matching sessions (< ${result.guards.refuseFloor}). ` +
          `Percentages from samples this small are noise. Re-run with --force to see it anyway.`,
      ),
    );
  } else {
    const est = `estimate ${pc.bold(pct(result.estimate))}`;
    const n = `N = ${result.n}`;
    lines.push(`  ${est}   ${n}   ${ciText(result.ci95)}   (${result.successes} hits)`);
    if (result.guards.lowSample) {
      lines.push(
        pc.yellow(`  ⚠ LOW SAMPLE. N < ${result.guards.warnFloor}; treat as anecdote, not edge`),
      );
    }
  }

  if (result.stability && result.stability.agree !== null) {
    const s = result.stability;
    const mark = s.agree ? pc.green("halves agree ✓") : pc.red("halves DISAGREE ✗");
    lines.push(
      `  stability: ${pct(s.firstHalf.estimate)} (n=${s.firstHalf.n}) vs ${pct(s.secondHalf.estimate)} (n=${s.secondHalf.n}) · ${mark}`,
    );
  }
  if (result.recency) {
    const r = result.recency;
    const div = r.diverges === true ? pc.red(": diverges from all-history") : "";
    lines.push(
      `  recency(last ${r.window}): ${pct(r.estimate)} (n=${r.n}) ${ciText(r.ci95)}${div}`,
    );
  }
  if (result.distribution) {
    const d = result.distribution;
    lines.push(
      `  ${pc.dim("distribution")} (${d.unit}, n=${d.count}): median ${d.median} · p25 ${d.p25} · p75 ${d.p75} · p90 ${d.p90}`,
    );
  }
  if (result.perYear.length > 1) {
    const parts = result.perYear.map((y) => `${y.year} ${pct(y.estimate)} (${y.n})`);
    lines.push(`  per-year: ${parts.join(" · ")}`);
  }
  if (result.groups && result.groups.length > 0) {
    lines.push("");
    lines.push(pc.bold("  by group:"));
    for (const g of result.groups) {
      const flag = g.lowSample ? pc.yellow(" ⚠") : "";
      lines.push(
        `    ${g.group.padEnd(12)} ${pct(g.estimate).padStart(7)}   N=${String(g.n).padStart(4)}   ${ciText(g.ci95)}${flag}`,
      );
    }
  }
  if (result.sessions.length > 0) {
    const shown = result.sessions.slice(0, 8);
    const rest = result.sessions.length - shown.length;
    lines.push("");
    lines.push(
      pc.dim(
        `  latest matches: ${shown
          .map((s) => `${s.tradeDate}${s.success ? "✓" : "✗"}`)
          .join(" ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
      ),
    );
  }
  lines.push("");
  lines.push(pc.dim(`  ${result.disclaimer}`));
  lines.push(
    pc.dim(
      `  engine ${result.engine.version} · store ${result.engine.storeFingerprint} · calendars ${result.engine.calendarVersion}`,
    ),
  );
  return lines.join("\n");
}

export function fail(message: string): never {
  console.error(pc.red(message));
  process.exit(1);
}
