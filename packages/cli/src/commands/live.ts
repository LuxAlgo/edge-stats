/*
  `edgestats live`: the Live Board on the terminal. The loop syncs bars,
  checks whether each watch's conditions hold on the developing session,
  and shows/alerts the HISTORICAL conditional estimate (always with N and
  the 95% CI). Frequencies, not forecasts — the disclaimer travels with
  every rendered setup and every fired alert.
*/
import pc from "picocolors";
import {
  DISCLAIMER,
  emitAlert,
  evaluatePass,
  getLiveConfig,
  listAlerts,
  replayAlert,
  runLiveLoop,
  syncSymbols,
  type EvaluatePassOptions,
  type LiveSetupState,
} from "@luxalgo/edge-stats";
import type { CliContext } from "../context";
import { pct, renderResult } from "../render";

const NOT_CONFIGURED = `live is not configured: add a "live" block to edge-stats.config.json, e.g.:

  "live": {
    "enabled": true,
    "intervalSec": 300,
    "watch": [
      { "preset": "gap-fill", "params": { "dir": "down" }, "symbol": "DEMO_STK",
        "threshold": { "min": 0.7 }, "minN": 30 }
    ],
    "sinks": [{ "type": "ndjson", "path": "alerts.ndjson" }]
  }

see docs/live-board.md for the full reference.`;

function phaseCell(phase: LiveSetupState["phase"]): string {
  const text = phase.padEnd(8);
  if (phase === "active") return pc.green(text);
  if (phase === "forming") return pc.yellow(text);
  return pc.dim(text);
}

function ciCell(ci: [number, number] | null): string {
  if (!ci) return "—".padEnd(17);
  return `[${pct(ci[0])}, ${pct(ci[1])}]`.padEnd(17);
}

export function renderSetups(setups: LiveSetupState[]): string {
  const lines: string[] = [];
  lines.push(
    pc.dim(
      `  ${"SYMBOL".padEnd(10)} ${"DATE".padEnd(11)} ${"PHASE".padEnd(8)} ${"ESTIMATE".padStart(8)}  ${"95% CI".padEnd(17)} ${"N".padStart(5)}  QUERY`,
    ),
  );
  for (const s of setups) {
    const low = s.lowSample ? pc.yellow(" ⚠ low sample") : "";
    lines.push(
      `  ${s.symbol.padEnd(10)} ${s.tradeDate.padEnd(11)} ${phaseCell(s.phase)} ${pct(s.estimate).padStart(8)}  ${ciCell(s.ci95)} ${String(s.n).padStart(5)}  ${s.dsl}${low}`,
    );
  }
  const evaluatedAt = setups[0]?.evaluatedAt;
  lines.push("");
  lines.push(pc.dim(`  ${DISCLAIMER}${evaluatedAt ? ` · evaluated ${evaluatedAt}` : ""}`));
  return lines.join("\n");
}

export interface LiveRunOptions {
  sync: boolean;
  intervalSec?: number;
}

/** One evaluation pass: print the board, emit any new alerts, exit 0. */
export async function runLiveOnce(ctx: CliContext, opts: LiveRunOptions): Promise<void> {
  const live = getLiveConfig(ctx.config);
  if (live.watch.length === 0) {
    console.log(NOT_CONFIGURED);
    return;
  }
  const symbols = [...new Set(live.watch.map((w) => w.symbol))];
  let syncError: string | undefined;
  if (opts.sync) {
    try {
      await syncSymbols(ctx.store, ctx.config, {
        symbols,
        log: (msg) => console.log(pc.dim(msg)),
      });
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      console.error(
        pc.yellow(`live: sync failed (${syncError}): evaluating against the last synced data`),
      );
    }
  }
  const passOpts: EvaluatePassOptions =
    syncError === undefined ? { now: new Date() } : { now: new Date(), syncError };
  const { setups, alertsFired } = await evaluatePass(ctx.store, ctx.config, passOpts);
  for (const payload of alertsFired) {
    await emitAlert(live.sinks, payload, process.env);
  }
  console.log(renderSetups(setups));
  if (alertsFired.length > 0) {
    console.log(
      pc.bold(`  ${alertsFired.length} alert(s) fired: replay with \`edgestats live alerts\``),
    );
  } else {
    console.log(pc.dim("  no new alerts this pass"));
  }
}

/** The loop: evaluate on the configured interval until SIGINT/SIGTERM. */
export async function runLiveWatch(ctx: CliContext, opts: LiveRunOptions): Promise<void> {
  const live = getLiveConfig(ctx.config);
  if (live.watch.length === 0) {
    console.log(NOT_CONFIGURED);
    return;
  }
  if (!live.enabled) {
    console.log(
      `live.enabled is false: set it to true in edge-stats.config.json, or run \`edgestats live --once\` for a single pass.`,
    );
    return;
  }
  const intervalSec = opts.intervalSec ?? live.intervalSec;
  console.log(
    pc.bold(
      `live board: ${live.watch.length} watch(es) · every ${intervalSec}s · ${live.sinks.length} sink(s)`,
    ),
  );
  console.log(pc.dim(`  ${DISCLAIMER}`));
  console.log(pc.dim("  Ctrl+C stops the loop and marks live_state disabled\n"));

  const controller = new AbortController();
  const stop = (): void => {
    console.error(pc.dim("\nlive: shutting down: writing live_state enabled:false"));
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runLiveLoop(ctx.store, ctx.config, {
      intervalSec: opts.intervalSec,
      signal: controller.signal,
      syncFirst: opts.sync,
      log: (msg) => console.error(pc.dim(`  ${msg}`)),
      onPass: ({ setups, alertsFired }) => {
        console.log(renderSetups(setups));
        if (alertsFired.length > 0) {
          console.log(pc.bold(`  ${alertsFired.length} alert(s) fired`));
        }
        console.log("");
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runLiveAlerts(ctx: CliContext, limit: number): Promise<void> {
  const alerts = await listAlerts(ctx.store, { limit });
  if (alerts.length === 0) {
    console.log(pc.dim("no alerts fired yet"));
    return;
  }
  for (const a of alerts) {
    console.log(`${a.firedAt}  ${pc.bold(a.id)}  ${a.symbol}  ${pc.dim(a.query)}`);
  }
  console.log(
    pc.dim(`\n${alerts.length} alert(s): replay one with \`edgestats live replay <id>\``),
  );
}

export async function runLiveReplay(ctx: CliContext, id: string): Promise<void> {
  const snapshot = await replayAlert(ctx.store, id);
  const p = snapshot.payload;
  console.log(pc.bold(`alert ${p.id}`));
  console.log(
    pc.dim(
      `  fired ${p.firedAt} · phase active · threshold ${JSON.stringify(p.threshold)} · store ${p.storeFingerprint}`,
    ),
  );
  console.log(
    `  ${p.symbol} ${p.tradeDate} (${p.sessionKey}): estimate ${pct(p.estimate)} · N = ${p.n} · 95% CI [${pct(p.ci95[0])}, ${pct(p.ci95[1])}]`,
  );
  console.log("");
  try {
    console.log(renderResult(snapshot.envelope));
  } catch {
    // A snapshot from a future/older engine may not render — show it raw.
    console.log(JSON.stringify(snapshot, null, 2));
  }
}
