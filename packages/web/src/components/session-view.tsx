/*
  Session view: the bars behind ONE matched session on a Vela chart
  (@luxalgo/vela, Apache-2.0), with the query's levels drawn over them, so a
  statistic like "gap filled 80%" can be checked against what a session
  really looked like. A verification tool, not a signal: nothing here
  predicts anything, it shows what happened.

  Vela is loaded with a dynamic import the first time a session view opens,
  so the dashboard bundle and its first paint are unchanged. The chart is
  built once per open view; flipping through sessions swaps the bars with
  setMarket() and lets the level overlay (a native indicator that reads the
  current session) restart, instead of rebuilding the chart. Vela's
  attribution mark stays on: it is the library's own, and it stays.
*/
import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type {
  Background,
  DrawingBox,
  DrawingLabel,
  DrawingLine,
  NativeIndicatorOutput,
  Vela as VelaChart,
} from "@luxalgo/vela";
import type { QueryResult, SessionBarsResult, SessionRef } from "../lib/api";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { fmtNum, fmtValue } from "../lib/format";
import { Badge, Button, ErrorNote, Skeleton } from "./ui";

/** Literal dashboard palette for the chart: Vela wants colors, not CSS variables. */
const CHART_THEME = {
  background: "#0a0a0a",
  textColor: "#a0a0a0",
  gridColor: "#161616",
  borderColor: "#1f1f1f",
  upColor: "#35cd78",
  downColor: "#f23645",
  fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif',
};
const INK = { foreground: "#ededed", muted: "#a0a0a0", faint: "#7d7d7d", accent: "#0d8ed6" };
const CHART_HEIGHT = 460;
const CONTEXT_BARS = 30;
/**
 * Blank bars kept to the right of the last candle. Vela's zoom-out limit is
 * "all bars plus a small margin fill the width", so this must stay small or
 * the frame loses the open instead of gaining whitespace.
 */
const RIGHT_MARGIN_BARS = 5;
const PANE = "price";

/** Store timeframe ("1m", "5m", "1h", "1d") → Vela timeframe ("1", "5", "60", "1D"). */
function velaTimeframe(tf: string): string {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  if (!m) return "1";
  const n = Number(m[1]);
  if (m[2] === "m") return String(n);
  if (m[2] === "h") return String(n * 60);
  return `${n}D`;
}

function tfMillis(tf: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  if (!m) return 60_000;
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

function clock(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** Which level and event time the query's outcome is about, for the marker. */
interface OutcomeMarker {
  level: number;
  /** Minutes from the open, when the event happened. */
  min: number | null;
  /** Verb for the marker text: "filled", "touched", "broke up". */
  verb: string;
  /** What to say at the level when the event never happened. */
  never: string;
  /** Marker bubble above the level (price came from below) or below it. */
  side: "above" | "below";
}

function durationMinutes(arg: { t: string; v: unknown; unit?: string } | undefined): number | null {
  if (!arg || arg.t !== "num" || typeof arg.v !== "number") return null;
  return arg.unit === "h" ? arg.v * 60 : arg.v;
}

/** The opening-range window the outcome names, if it is an OR outcome. */
function outcomeOrWindow(result: QueryResult, view: SessionBarsResult): number | null {
  const { name, args } = result.query.ast.outcome;
  if (name === "orbBreak" || name === "orbFalseBreak" || name === "orbTargetHit") {
    return durationMinutes(args[0]);
  }
  if (name === "ibExtension") return view.levels.ibWindow;
  return null;
}

function outcomeMarkerFor(result: QueryResult, view: SessionBarsResult): OutcomeMarker | null {
  const name = result.query.ast.outcome.name;
  const { levels, times } = view;
  if (name === "gapFill" || name === "gapReversal" || name === "gapHold") {
    if (levels.prevClose === null || (levels.gapDir !== "up" && levels.gapDir !== "down")) {
      return null;
    }
    return {
      level: levels.prevClose,
      min: times.gapFillMin,
      verb: "filled",
      never: "not filled",
      side: levels.gapDir === "down" ? "above" : "below",
    };
  }
  if (name === "touchPrevHigh" || name === "breakHoldPrevHigh") {
    if (levels.prevHigh === null) return null;
    return {
      level: levels.prevHigh,
      min: times.touchPrevHighMin,
      verb: "touched",
      never: "not touched",
      side: "above",
    };
  }
  if (name === "touchPrevLow" || name === "breakHoldPrevLow") {
    if (levels.prevLow === null) return null;
    return {
      level: levels.prevLow,
      min: times.touchPrevLowMin,
      verb: "touched",
      never: "not touched",
      side: "below",
    };
  }
  const orWindow = outcomeOrWindow(result, view);
  if (orWindow !== null) {
    const or = levels.openingRanges.find((o) => o.window === orWindow);
    if (!or || or.high === null || or.low === null) return null;
    if (or.firstBreak === "up") {
      return { level: or.high, min: or.breakMin, verb: "broke up", never: "", side: "above" };
    }
    if (or.firstBreak === "down") {
      return { level: or.low, min: or.breakMin, verb: "broke down", never: "", side: "below" };
    }
    return { level: or.high, min: null, verb: "", never: "range held", side: "above" };
  }
  if (name === "timeOfHighBefore" && levels.high !== null) {
    return { level: levels.high, min: times.highTimeMin, verb: "high", never: "", side: "above" };
  }
  if (name === "timeOfLowBefore" && levels.low !== null) {
    return { level: levels.low, min: times.lowTimeMin, verb: "low", never: "", side: "below" };
  }
  return null;
}

/**
 * Everything drawn over the candles for one session: level lines with
 * labels, the opening-range box, the gap band, the pre-session shade, and
 * the outcome marker. Pure: the same view and query give the same overlay.
 */
function buildOverlay(view: SessionBarsResult, result: QueryResult): NativeIndicatorOutput {
  const { levels, tz } = view;
  const tfMs = tfMillis(view.tf);
  const startTs = view.startTs;
  const lastTs = view.bars.at(-1)?.ts ?? view.endTs - tfMs;
  // Right-edge labels anchor in the margin past the last bar; their bodies
  // extend left ("label_right" points right at the anchor) so nothing clips.
  const edgeTs = lastTs + RIGHT_MARGIN_BARS * tfMs;
  const lines: DrawingLine[] = [];
  const labels: DrawingLabel[] = [];
  const boxes: DrawingBox[] = [];
  const backgrounds: Background[] = [];

  const line = (
    id: string,
    y: number,
    color: string,
    style: DrawingLine["style"],
    width = 1,
  ): DrawingLine => ({
    id,
    paneId: PANE,
    xloc: "bar_time",
    x1: startTs,
    y1: y,
    x2: lastTs,
    y2: y,
    extend: "none",
    color,
    invisible: false,
    width,
    style,
    arrowLeft: false,
    arrowRight: false,
    overlay: true,
  });
  const tag = (
    id: string,
    x: number,
    y: number,
    text: string,
    style: DrawingLabel["style"],
    color: string,
    textColor = INK.foreground,
  ): DrawingLabel => ({
    id,
    paneId: PANE,
    xloc: "bar_time",
    x,
    y,
    yloc: "price",
    text,
    style,
    color,
    textColor,
    size: "small",
    textAlign: "left",
    fontFamily: "default",
    overlay: true,
  });
  const price = (v: number) => fmtNum(v, 2);

  // Pre-session context: shaded, so it cannot be read as the session (the
  // footnote under the chart says what it is).
  const firstContext = view.context.bars[0];
  if (firstContext) {
    backgrounds.push({
      id: "context",
      paneId: PANE,
      from: firstContext.ts,
      to: startTs,
      color: "rgba(255, 255, 255, 0.035)",
      overlay: true,
    });
  }

  // Prior-session levels: dashed, quiet, labelled on the right.
  const prior: [string, number | null][] = [
    ["prior high", levels.prevHigh],
    ["prior low", levels.prevLow],
  ];
  for (const [name, y] of prior) {
    if (y === null) continue;
    const id = name.replace(" ", "-");
    lines.push(line(id, y, INK.faint, "dashed"));
    labels.push(
      tag(`${id}-label`, edgeTs, y, `${name} ${price(y)}`, "label_right", "#1f1f1f", INK.muted),
    );
  }
  if (levels.prevClose !== null) {
    lines.push(line("prior-close", levels.prevClose, INK.muted, "solid"));
    labels.push(
      tag(
        "prior-close-label",
        edgeTs,
        levels.prevClose,
        `prior close ${price(levels.prevClose)}`,
        "label_right",
        "#1f1f1f",
        INK.foreground,
      ),
    );
  }

  // Session open: dotted, labelled over the context bars on the left so it
  // never collides with the prior close.
  if (levels.open !== null) {
    lines.push(line("open", levels.open, INK.foreground, "dotted"));
    labels.push(
      tag(
        "open-label",
        firstContext?.ts ?? startTs,
        levels.open,
        `open ${price(levels.open)}`,
        "label_left",
        "#1f1f1f",
      ),
    );
  }

  // The gap: a band between the prior close and the open, over the first bars.
  if (levels.prevClose !== null && levels.open !== null && levels.open !== levels.prevClose) {
    const gapEnd =
      view.times.gapFillMin !== null
        ? Math.min(lastTs, startTs + view.times.gapFillMin * 60_000)
        : lastTs;
    boxes.push({
      id: "gap",
      paneId: PANE,
      xloc: "bar_time",
      left: startTs,
      top: Math.max(levels.prevClose, levels.open),
      right: Math.max(gapEnd, startTs + tfMs),
      bottom: Math.min(levels.prevClose, levels.open),
      extend: "none",
      bgColor: "rgba(255, 255, 255, 0.09)",
      borderWidth: 0,
      borderStyle: "solid",
      textSize: "small",
      hAlign: "left",
      vAlign: "center",
      wrap: false,
      fontFamily: "default",
      bold: false,
      italic: false,
      overlay: true,
    });
  }

  // The opening range the outcome is about: a box over its window.
  const orWindow = outcomeOrWindow(result, view);
  const or =
    orWindow !== null ? levels.openingRanges.find((o) => o.window === orWindow) : undefined;
  if (or && or.high !== null && or.low !== null) {
    boxes.push({
      id: "opening-range",
      paneId: PANE,
      xloc: "bar_time",
      left: startTs,
      top: or.high,
      right: startTs + or.window * 60_000 - tfMs,
      bottom: or.low,
      extend: "none",
      bgColor: "rgba(13, 142, 214, 0.12)",
      borderColor: "rgba(13, 142, 214, 0.7)",
      borderWidth: 1,
      borderStyle: "solid",
      textSize: "small",
      hAlign: "left",
      vAlign: "top",
      wrap: false,
      fontFamily: "default",
      bold: false,
      italic: false,
      overlay: true,
    });
    lines.push(line("or-high", or.high, INK.accent, "dashed"));
    lines.push(line("or-low", or.low, INK.accent, "dashed"));
    labels.push(
      tag(
        "or-high-label",
        edgeTs,
        or.high,
        `OR high ${price(or.high)}`,
        "label_right",
        "#1f1f1f",
        INK.accent,
      ),
    );
    labels.push(
      tag(
        "or-low-label",
        edgeTs,
        or.low,
        `OR low ${price(or.low)}`,
        "label_right",
        "#1f1f1f",
        INK.accent,
      ),
    );
  }

  // The outcome marker: where and when the measured event happened.
  const marker = outcomeMarkerFor(result, view);
  if (marker) {
    if (marker.min !== null) {
      const x = Math.min(lastTs, startTs + marker.min * 60_000);
      labels.push(
        tag(
          "outcome",
          x,
          marker.level,
          `${marker.verb} ${clock(x, tz)}`,
          marker.side === "above" ? "label_down" : "label_up",
          INK.accent,
          "#ffffff",
        ),
      );
    } else if (marker.never !== "") {
      labels.push({
        id: "outcome-never",
        paneId: PANE,
        xloc: "bar_time",
        x: startTs + Math.floor((lastTs - startTs) / 2),
        y: marker.level,
        yloc: "price",
        text: marker.never,
        style: "none",
        textColor: INK.muted,
        size: "small",
        textAlign: "center",
        fontFamily: "default",
        noFill: true,
        overlay: true,
      });
    }
  }

  return { lines, labels, boxes, backgrounds };
}

/**
 * The chart's market for one session: context + session bars, the store's
 * timeframe, and a frame that shows the whole session with room on the
 * right for the level labels (instead of Vela's default "latest bars" view).
 */
function marketFor(view: SessionBarsResult) {
  const tfMs = tfMillis(view.tf);
  const bars = [...view.context.bars, ...view.bars];
  const first = bars[0]?.ts ?? view.startTs;
  const last = bars.at(-1)?.ts ?? view.endTs - tfMs;
  return {
    data: bars.map((b) => ({
      time: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
    timeframe: velaTimeframe(view.tf),
    visibleRange: { from: first, to: last + RIGHT_MARGIN_BARS * tfMs },
  };
}

let mountCounter = 0;

/**
 * The Vela chart itself. One instance per mounted component: the first
 * session builds it (after the lazy import), later sessions swap bars with
 * setMarket() and the overlay indicator restarts with the new levels.
 */
function SessionChart({ view, result }: { view: SessionBarsResult; result: QueryResult }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<VelaChart | null>(null);
  const latestRef = useRef<{ view: SessionBarsResult; result: QueryResult }>({ view, result });
  latestRef.current = { view, result };

  const market = useMemo(() => marketFor(view), [view]);

  // Build once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const type = `edge-session-levels-${(mountCounter += 1)}`;

    void (async () => {
      const { Vela, registerNativeIndicator, unregisterNativeIndicator } =
        await import("@luxalgo/vela");
      if (disposed) return;

      // The overlay reads whatever session is current when it (re)starts, which
      // is exactly what setMarket() triggers on a session change.
      registerNativeIndicator({
        type,
        title: "Session levels",
        shortTitle: "levels",
        paneHint: "price",
        overlay: true,
        inputsSchema: () => [],
        defaultInputs: () => ({}),
        create: () => ({
          start(ctx) {
            const current = latestRef.current;
            ctx.emit(buildOverlay(current.view, current.result));
            ctx.setStatus("idle");
          },
          onBars() {},
          onViewport() {},
          setInputs() {},
          suspend() {},
          resume() {},
          stop() {},
        }),
      });

      const first = latestRef.current.view;
      const chart = new Vela(host, {
        ...marketFor(first),
        theme: CHART_THEME,
        height: CHART_HEIGHT,
        live: false,
        drawings: false,
        volume: false,
        currentPriceLine: false,
        animations: false,
      });
      // Historical bars: the session's own clock, and no last-price tag or
      // bar-close countdown pretending anything is live.
      chart.renderer.set({ timezone: first.tz, priceLabel: false, countdown: false });
      chart.addNativeIndicator(type);
      chartRef.current = chart;
      cleanup = () => {
        chartRef.current = null;
        chart.destroy();
        unregisterNativeIndicator(type);
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // Then swap sessions in place.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.renderer.set("timezone", view.tz);
    void chart.setMarket(market);
  }, [market, view.tz]);

  return (
    <div
      ref={hostRef}
      style={{ height: CHART_HEIGHT }}
      className="overflow-hidden rounded-lg border border-border bg-card"
      role="img"
      aria-label={`${view.symbol} ${view.tradeDate} session bars with the query's levels`}
    />
  );
}

function Flag({ children }: { children: string }) {
  return <Badge tone="warn">{children}</Badge>;
}

/**
 * The session view dialog: header with the session's identity, the query,
 * and its outcome for this session (formatted as the results panel does),
 * the chart, and previous/next navigation across the result's sessions.
 */
export function SessionView({
  result,
  sessionId,
  onNavigate,
  onClose,
}: {
  result: QueryResult;
  sessionId: string;
  onNavigate: (sessionId: string) => void;
  onClose: () => void;
}) {
  const sessions: SessionRef[] = result.sessions;
  const index = sessions.findIndex((s) => s.sessionId === sessionId);
  const ref = index >= 0 ? sessions[index] : undefined;
  // `sessions` is most-recent first, so "older" moves down the list.
  const older = index >= 0 ? sessions[index + 1] : undefined;
  const newer = index > 0 ? sessions[index - 1] : undefined;
  const unit = result.distribution?.unit ?? "";

  const { data, error, loading } = useAsync(
    (signal) => api.sessionBars(sessionId, { context: CONTEXT_BARS }, signal),
    [sessionId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && older) onNavigate(older.sessionId);
      else if (e.key === "ArrowRight" && newer) onNavigate(newer.sessionId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, older, newer]);

  const title = data
    ? `${data.symbol} · ${data.tradeDate}`
    : ref
      ? `${result.query.symbol} · ${ref.tradeDate}`
      : sessionId;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed inset-x-0 top-0 z-50 flex h-full items-start justify-center overflow-y-auto p-4 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Session view"
        onClick={onClose}
      >
        <section
          className="w-full max-w-6xl rounded-xl border border-border bg-popover p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
                Session view
              </div>
              <h2 className="stat mt-1.5 text-xl font-medium tracking-tight">{title}</h2>
              <div className="stat mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                <Badge>session {data?.sessionKey ?? result.query.sessionKey}</Badge>
                {data ? <Badge>{data.tf} bars</Badge> : null}
                {data && data.levels.gapPct !== null && data.levels.gapDir !== "none" ? (
                  <Badge title="Open versus the prior session's close, as the engine derived it">
                    gap {data.levels.gapPct > 0 ? "+" : ""}
                    {fmtNum(data.levels.gapPct, 2)}%
                  </Badge>
                ) : null}
                {data?.isHalfDay ? <Flag>half day</Flag> : null}
                {data?.isRollDay ? <Flag>roll day</Flag> : null}
                {data && !data.complete ? <Flag>incomplete session</Flag> : null}
              </div>
            </div>
            <div className="min-w-0 max-w-full space-y-2 text-right">
              <code className="block max-w-full overflow-x-auto whitespace-nowrap rounded-lg border border-white/[0.08] bg-black/60 px-2.5 py-1.5 text-left font-mono text-xs">
                {result.query.dsl}
              </code>
              {ref ? (
                <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
                  {ref.success ? <Badge tone="green">hit</Badge> : <Badge tone="red">miss</Badge>}
                  {ref.value !== null ? (
                    <span className="stat font-mono text-[13px] text-muted-foreground">
                      value {fmtValue(ref.value, unit)}
                    </span>
                  ) : null}
                  <span className="stat font-mono text-[11px] text-faint">
                    {index + 1} of {sessions.length} listed
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            {error ? (
              <ErrorNote error={error} />
            ) : data ? (
              <SessionChart view={data} result={result} />
            ) : loading ? (
              <div style={{ height: CHART_HEIGHT }}>
                <Skeleton className="h-full w-full" />
              </div>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                onClick={() => older && onNavigate(older.sessionId)}
                disabled={!older}
                title="Older matched session (←)"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                older
              </Button>
              <Button
                onClick={() => newer && onNavigate(newer.sessionId)}
                disabled={!newer}
                title="Newer matched session (→)"
              >
                newer
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            <Button onClick={onClose} title="Close (Esc)">
              <X className="size-3.5" aria-hidden="true" />
              close
            </Button>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-faint">
            {data ? `${data.context.note} ` : ""}
            Levels are the engine's own derived numbers for this session; the bars are your stored
            data, read from this session's partition alone. Chart drawn by{" "}
            <a
              href="https://github.com/LuxAlgo/Vela"
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
            >
              Vela
            </a>
            . A way to check a statistic against a session, not a signal.
          </p>
          <p className="mt-2 font-mono text-[10.5px] text-muted-foreground">{result.disclaimer}</p>
        </section>
      </div>
    </>
  );
}
