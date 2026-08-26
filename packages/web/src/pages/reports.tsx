/*
  '/': the report catalog. Preset cards run lazily through a shared
  4-slot query pool; each card shows the estimate with its CI and N or an
  honest "N too small", never a bare number.
*/
import { useCallback, useState } from "react";
import { Link } from "wouter";
import type { Preset, PresetRunResult, QueryResult } from "../lib/api";
import { api } from "../lib/api";
import { useAsync, useCachedAsync, useUrlParams, withQuerySlot } from "../lib/hooks";
import { EnvelopeFooter } from "../components/results-panel";
import { Estimate } from "../components/estimate";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  ErrorNote,
  Labeled,
  Panel,
  SectionLabel,
  SelectInput,
  Skeleton,
  StabilityTick,
} from "../components/ui";

function PresetCard({
  preset,
  symbol,
  onEnvelope,
}: {
  preset: Preset;
  symbol: string;
  onEnvelope: (r: QueryResult) => void;
}) {
  const run = useAsync<PresetRunResult>(
    (signal) =>
      withQuerySlot(signal, async () => {
        const result = await api.preset({ presetId: preset.id, symbol, sessionsLimit: 0 }, signal);
        onEnvelope(result);
        return result;
      }),
    [preset.id, symbol],
  );

  const body = run.loading ? (
    <div className="mt-3 space-y-2">
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-4 w-40" />
    </div>
  ) : run.error ? (
    <div className="mt-3">
      <ErrorNote error={run.error} compact />
      <div className="mt-2">
        <Button
          onClick={() => {
            run.reload();
          }}
        >
          retry
        </Button>
      </div>
    </div>
  ) : run.data ? (
    <div className="mt-3 flex items-end justify-between gap-3">
      <Estimate
        size="md"
        facts={{
          estimate: run.data.estimate,
          ci95: run.data.ci95,
          n: run.data.n,
          lowSample: run.data.guards.lowSample,
        }}
      />
      {/* A stability tick over a refused sample would be noise, not honesty. */}
      {run.data.guards.refused ? null : <StabilityTick agree={run.data.stability?.agree ?? null} />}
    </div>
  ) : null;

  return (
    <Link
      href={`/report/${preset.id}?symbol=${encodeURIComponent(symbol)}`}
      className="group block rounded-xl border border-line bg-panel p-5 transition hover:border-accent/60"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone="accent">{preset.category}</Badge>
        <span className="text-xs text-dim opacity-0 transition group-hover:opacity-100">
          open report →
        </span>
      </div>
      <h3 className="mt-2.5 text-base font-semibold tracking-tight">{preset.title}</h3>
      {body}
    </Link>
  );
}

export function ReportsPage() {
  const { params, patch } = useUrlParams();
  const symbols = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const presets = useCachedAsync("presets", (signal) => api.presets(signal));
  const [envelope, setEnvelope] = useState<QueryResult | null>(null);
  const onEnvelope = useCallback((r: QueryResult) => {
    setEnvelope((prev) => prev ?? r);
  }, []);

  const symbolList = symbols.data?.symbols ?? [];
  const symbol = params.get("symbol") ?? symbolList[0]?.symbol ?? "";

  const byCategory = new Map<string, Preset[]>();
  for (const p of presets.data?.presets ?? []) {
    const bucket = byCategory.get(p.category);
    if (bucket) bucket.push(p);
    else byCategory.set(p.category, [p]);
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-dim">
            Every card is one conditional-probability query over your own sessions. The number never
            travels without its sample size and 95% interval: and below the refuse floor there is no
            number at all.
          </p>
        </div>
        <div className="w-44">
          <Labeled label="Symbol">
            <SelectInput ariaLabel="Symbol" value={symbol} onChange={(v) => patch({ symbol: v })}>
              {symbolList.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                </option>
              ))}
            </SelectInput>
          </Labeled>
        </div>
      </div>

      <div className="mt-8 space-y-10">
        {symbols.error ? <ErrorNote error={symbols.error} /> : null}
        {presets.error ? <ErrorNote error={presets.error} /> : null}

        {!symbols.loading && symbolList.length === 0 ? (
          <EmptyState title="No symbols configured yet">
            <p>
              The engine found no symbols in <code>edge-stats.config.json</code>. Try the seeded
              demo market first, then point an adapter at your own bars:
            </p>
            <div className="mt-3 text-left">
              <CodeBlock>{"edgestats init --demo\nedgestats serve"}</CodeBlock>
            </div>
          </EmptyState>
        ) : null}

        {!presets.loading && (presets.data?.presets.length ?? 0) === 0 && symbolList.length > 0 ? (
          <EmptyState title="No presets installed">
            <p>
              Presets are plain JSON query files in the <code>presets/</code> folder: one outcome,
              base conditions, and parameter specs each. Drop a file in (or extend the catalog by
              pull request) and it appears here, in the CLI, and in the MCP server at once.
            </p>
          </EmptyState>
        ) : null}

        {presets.loading || symbols.loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Panel key={i} className="p-5">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="mt-3 h-5 w-40" />
                <Skeleton className="mt-4 h-9 w-28" />
                <Skeleton className="mt-2 h-4 w-44" />
              </Panel>
            ))}
          </div>
        ) : (
          [...byCategory.entries()].map(([category, items]) => (
            <section key={category}>
              <SectionLabel>{category}</SectionLabel>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((preset) =>
                  symbol === "" ? null : (
                    <PresetCard
                      key={`${preset.id}:${symbol}`}
                      preset={preset}
                      symbol={symbol}
                      onEnvelope={onEnvelope}
                    />
                  ),
                )}
              </div>
            </section>
          ))
        )}
      </div>

      {envelope ? <EnvelopeFooter result={envelope} /> : null}
    </div>
  );
}
