/*
  '/live': the Live Board. When the live module is enabled it evaluates
  configured watches against the developing session and this page polls the
  state every 30 seconds. When it's off, the page teaches how to turn it on.
*/
import { useEffect, useState } from "react";
import type { LiveSetupState } from "../lib/api";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { Estimate } from "../components/estimate";
import { fmtDateTime, LIVE_FOOTNOTE, relTime } from "../lib/format";
import {
  Badge,
  CodeBlock,
  EmptyState,
  ErrorNote,
  Panel,
  SectionLabel,
  Skeleton,
} from "../components/ui";
import type { Tone } from "../components/ui";

const REFRESH_MS = 30_000;

const PHASE_TONE: Record<LiveSetupState["phase"], Tone> = {
  forming: "dim",
  active: "accent",
  resolved: "green",
};

const CONFIG_SNIPPET = `{
  "live": {
    "enabled": true,
    "intervalSec": 300,
    "watch": [
      {
        "preset": "gap-fill",
        "symbol": "DEMO_STK",
        "threshold": { "min": 0.75 },
        "minN": 50
      },
      { "dsl": "orbBreak(15m, up)", "symbol": "DEMO_FUT" }
    ],
    "sinks": [{ "type": "desktop" }, { "type": "ndjson", "path": "alerts.ndjson" }]
  }
}`;

function SetupCard({ setup }: { setup: LiveSetupState }) {
  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium tracking-tight">{setup.symbol}</span>
          <Badge tone="dim">session {setup.sessionKey}</Badge>
        </div>
        <Badge tone={PHASE_TONE[setup.phase]}>{setup.phase}</Badge>
      </div>
      <code className="stat mt-3 block overflow-x-auto whitespace-nowrap rounded-lg border border-white/[0.08] bg-black/60 px-2.5 py-1.5 font-mono text-xs">
        {setup.dsl}
      </code>
      <div className="mt-4">
        <Estimate
          size="md"
          label="Historical rate, given this session's state so far"
          facts={{
            estimate: setup.estimate,
            ci95: setup.ci95,
            n: setup.n,
            lowSample: setup.lowSample,
          }}
        />
      </div>
      <div className="stat mt-4 flex items-center justify-between font-mono text-[11px] text-faint">
        <span>trade date {setup.tradeDate}</span>
        <span title={fmtDateTime(setup.evaluatedAt)}>
          evaluated {relTime(Date.parse(setup.evaluatedAt))}
        </span>
      </div>
    </Panel>
  );
}

export function LivePage() {
  const state = useAsync((signal) => api.liveState(signal), []);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  useEffect(() => {
    const t = window.setInterval(() => {
      state.reload();
      setLastRefresh(Date.now());
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [state.reload]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Live Board</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Watches re-evaluate your queries against the developing session and alert through your
            own sinks. What you see is the historical rate given today's state so far: a frequency,
            not a forecast.
          </p>
        </div>
        {state.data?.enabled ? (
          <span className="stat font-mono text-[11px] text-faint">
            refreshes every 30s · last {relTime(lastRefresh)}
          </span>
        ) : null}
      </div>

      <div className="mt-8">
        {state.loading && state.data === null ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Panel key={i} className="p-5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="mt-3 h-8 w-full" />
                <Skeleton className="mt-4 h-10 w-40" />
              </Panel>
            ))}
          </div>
        ) : state.error ? (
          <ErrorNote error={state.error} />
        ) : state.data && !state.data.enabled ? (
          <div className="space-y-4">
            <EmptyState title="The Live Board is switched off">
              <p>
                Turn it on in <code>edge-stats.config.json</code>: declare what to watch (a preset
                or a raw DSL query per entry, with optional alert thresholds and a minimum N) and
                where alerts should go. Then keep the evaluator running alongside the server:
              </p>
            </EmptyState>
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Panel className="p-4">
                <SectionLabel>edge-stats.config.json</SectionLabel>
                <div className="mt-2">
                  <CodeBlock>{CONFIG_SNIPPET}</CodeBlock>
                </div>
              </Panel>
              <Panel className="p-4">
                <SectionLabel>Run the evaluator</SectionLabel>
                <div className="mt-2">
                  <CodeBlock>{"edgestats live"}</CodeBlock>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Every evaluation snapshot is stored locally and every alert payload is versioned.
                  replayable and auditable, never a mystery number. Sinks include webhooks, chat
                  bots, an NDJSON tail, and desktop notifications; nothing leaves your machine
                  unless you configure it to.
                </p>
              </Panel>
            </div>
          </div>
        ) : state.data && state.data.setups.length === 0 ? (
          <EmptyState title="Live is enabled, but nothing is being watched">
            <p>
              Add entries to <code>live.watch</code> in <code>edge-stats.config.json</code>: each
              one is a preset id (plus params) or a raw DSL query with a symbol.
            </p>
          </EmptyState>
        ) : state.data ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {state.data.setups.map((setup) => (
                <SetupCard key={setup.id} setup={setup} />
              ))}
            </div>
            <p className="mt-6 font-mono text-[10.5px] text-faint">{LIVE_FOOTNOTE}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
