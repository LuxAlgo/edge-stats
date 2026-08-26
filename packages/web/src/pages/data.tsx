/*
  '/data': where the numbers come from: per-symbol bar freshness, the
  versioned exchange calendars and their coverage horizons, the available
  adapters, and the store fingerprint that stamps every result.
*/
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { daysUntil, fmtDateTime, relTime } from "../lib/format";
import { Badge, EmptyState, ErrorNote, Panel, SectionLabel, Skeleton } from "../components/ui";
import type { Tone } from "../components/ui";

function stalenessTone(ms: number | null): { tone: Tone; label: string } {
  if (ms === null) return { tone: "red", label: "no bars" };
  const ageHours = (Date.now() - ms) / 3_600_000;
  if (ageHours <= 26) return { tone: "green", label: relTime(ms) };
  if (ageHours <= 24 * 7) return { tone: "dim", label: relTime(ms) };
  return { tone: "warn", label: `stale: ${relTime(ms)}` };
}

function horizonTone(to: string): { tone: Tone; label: string } {
  const days = daysUntil(to);
  if (!Number.isFinite(days)) return { tone: "dim", label: "unknown horizon" };
  if (days < 0) return { tone: "red", label: "horizon passed" };
  if (days < 90) return { tone: "warn", label: `${days}d of horizon left` };
  return { tone: "green", label: `${days}d of horizon left` };
}

export function DataPage() {
  const freshness = useAsync((signal) => api.freshness(signal), []);
  const adapters = useAsync((signal) => api.adapters(signal), []);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Data</h1>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-dim">
        Everything lives on this machine: bars in parquet partitions, sessions and features in a
        local database, calendars as versioned data files with cited sources. Statistics are only as
        honest as the data under them: check it here.
      </p>

      <div className="mt-8 space-y-6">
        {freshness.error ? <ErrorNote error={freshness.error} /> : null}

        <Panel className="p-4">
          <SectionLabel>Symbols: last synced bar</SectionLabel>
          {freshness.loading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : freshness.data && freshness.data.symbols.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No symbols configured">
                <p>
                  Add symbols to <code>edge-stats.config.json</code> and run{" "}
                  <code>edgestats sync</code> to pull bars and derive session features.
                </p>
              </EmptyState>
            </div>
          ) : freshness.data ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-dim">
                    <th className="pb-2 pr-3 font-medium">Symbol</th>
                    <th className="pb-2 pr-3 font-medium">Adapter</th>
                    <th className="pb-2 pr-3 font-medium">Timeframe</th>
                    <th className="pb-2 pr-3 font-medium">Last bar</th>
                    <th className="pb-2 font-medium">Staleness</th>
                  </tr>
                </thead>
                <tbody>
                  {freshness.data.symbols.map((s) => {
                    const hint = stalenessTone(s.lastBarMs);
                    return (
                      <tr key={s.symbol} className="border-t border-line/60">
                        <td className="stat py-2.5 pr-3 font-semibold">{s.symbol}</td>
                        <td className="py-2.5 pr-3 text-dim">{s.adapter}</td>
                        <td className="stat py-2.5 pr-3">{s.tf}</td>
                        <td className="stat py-2.5 pr-3 text-dim">
                          {s.lastBar ? fmtDateTime(s.lastBar) : "—"}
                        </td>
                        <td className="py-2.5">
                          <Badge tone={hint.tone}>{hint.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-dim">
                Stale bars don't invalidate history: they just mean recent sessions are missing
                until the next <code>edgestats sync</code>.
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel className="p-4">
          <SectionLabel>Exchange calendars: versioned data files</SectionLabel>
          {freshness.loading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : freshness.data ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-dim">
                    <th className="pb-2 pr-3 font-medium">Exchange</th>
                    <th className="pb-2 pr-3 font-medium">Version</th>
                    <th className="pb-2 pr-3 font-medium">Coverage</th>
                    <th className="pb-2 font-medium">Horizon</th>
                  </tr>
                </thead>
                <tbody>
                  {freshness.data.calendars.map((c) => {
                    const horizon = horizonTone(c.coverage.to);
                    return (
                      <tr key={c.exchange} className="border-t border-line/60">
                        <td className="py-2.5 pr-3 font-semibold">{c.exchange}</td>
                        <td className="stat py-2.5 pr-3 font-mono text-xs">{c.version}</td>
                        <td className="stat py-2.5 pr-3 text-dim">
                          {c.coverage.from} → {c.coverage.to}
                        </td>
                        <td className="py-2.5">
                          <Badge tone={horizon.tone}>{horizon.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-dim">
                Holidays, half days, and DST all come from these files (sources cited inside).
                Sessions past the coverage horizon can't be resolved: refresh the calendar data
                before the horizon runs out.
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel className="p-4">
          <SectionLabel>Adapters: how bars get in</SectionLabel>
          {adapters.error ? (
            <div className="mt-3">
              <ErrorNote error={adapters.error} />
            </div>
          ) : adapters.loading ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(adapters.data?.adapters ?? []).map((a) => (
                <div key={a.id} className="rounded-lg border border-line bg-panel-2/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.title}</span>
                    <Badge tone="dim">
                      <span className="font-mono">{a.id}</span>
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-dim">{a.doc}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.requiresEnv.length === 0 ? (
                      <Badge tone="green">no credentials needed</Badge>
                    ) : (
                      a.requiresEnv.map((env) => (
                        <Badge key={env} tone="warn">
                          <span className="font-mono">{env}</span>
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {freshness.data ? (
          <div className="stat flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-line bg-panel px-4 py-2.5 font-mono text-[11px] text-dim">
            <span>engine v{freshness.data.engineVersion}</span>
            <span>store {freshness.data.storeFingerprint}</span>
            <span>calendar {freshness.data.calendarHash}</span>
            <span className="ml-auto font-sans italic">
              fingerprints stamp every result: same store, same query, same bytes
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
