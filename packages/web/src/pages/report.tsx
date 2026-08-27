/*
  '/report/:id': one preset, fully parameterized. Every control writes to
  the URL, so any configuration is a shareable, reproducible link. Runs are
  debounced and aborted on change; results render in the shared panel.
*/
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "wouter";
import type {
  Preset,
  PresetParam,
  PresetRunRequest,
  RegistryEntryDescription,
  SymbolConfig,
} from "../lib/api";
import { api } from "../lib/api";
import { useAsync, useCachedAsync, useDebounced, useUrlParams } from "../lib/hooks";
import { ResultsPanel, ResultsSkeleton } from "../components/results-panel";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Labeled,
  Panel,
  SectionLabel,
  SelectInput,
  Skeleton,
  TextInput,
} from "../components/ui";

export function sessionKeysFor(sym: SymbolConfig): string[] {
  const base = sym.assetClass === "crypto" ? "utc" : sym.assetClass === "forex" ? "london" : "rth";
  const keys = new Set<string>();
  if (sym.defaultSession) keys.add(sym.defaultSession);
  keys.add(base);
  for (const k of Object.keys(sym.sessions ?? {})) keys.add(k);
  return [...keys];
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: PresetParam;
  value: string;
  onChange: (v: string) => void;
}) {
  const placeholder = spec.default !== undefined ? `default ${String(spec.default)}` : "unset";
  let input;
  if (spec.type === "enum") {
    input = (
      <SelectInput ariaLabel={spec.name} value={value} onChange={onChange}>
        <option value="">{placeholder}</option>
        {(spec.values ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </SelectInput>
    );
  } else if (spec.type === "number" || spec.type === "duration") {
    input = (
      <div className="flex items-center gap-1.5">
        <TextInput
          ariaLabel={spec.name}
          type="number"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
        {spec.type === "duration" ? (
          <span className="text-xs text-muted-foreground">min</span>
        ) : null}
      </div>
    );
  } else {
    input = (
      <TextInput
        ariaLabel={spec.name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    );
  }
  return (
    <div>
      <Labeled label={spec.name} code>
        {input}
      </Labeled>
      <p className="mt-1.5 text-[11px] leading-snug text-faint">{spec.doc}</p>
    </div>
  );
}

function ReportRunner({
  requestJson,
  groupBy,
  onForce,
}: {
  requestJson: string;
  groupBy?: string;
  onForce: () => void;
}) {
  const debounced = useDebounced(requestJson, 300);
  const run = useAsync(
    (signal) => api.preset(JSON.parse(debounced) as PresetRunRequest, signal),
    [debounced],
  );
  const [openSession, setOpenSession] = useState<string | null>(null);

  if (run.loading) return <ResultsSkeleton />;
  if (run.error) return <ErrorNote error={run.error} />;
  if (!run.data) return null;
  return (
    <ResultsPanel
      result={run.data}
      groupBy={groupBy}
      onForce={onForce}
      openSession={openSession}
      onOpenSession={setOpenSession}
      onCloseSession={() => setOpenSession(null)}
    />
  );
}

export function ReportPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { params, patch } = useUrlParams();
  const presets = useCachedAsync("presets", (signal) => api.presets(signal));
  const symbols = useCachedAsync("symbols", (signal) => api.symbols(signal));
  const registry = useCachedAsync("registry", (signal) => api.registry(signal));

  const preset: Preset | null = presets.data?.presets.find((p) => p.id === id) ?? null;
  const symbolList = symbols.data?.symbols ?? [];
  const symbol = params.get("symbol") ?? symbolList[0]?.symbol ?? "";
  const symbolConfig = symbolList.find((s) => s.symbol === symbol) ?? null;

  const groupable: RegistryEntryDescription[] = (registry.data?.entries ?? []).filter(
    (e) => e.kind === "field" && e.groupable === true,
  );

  const sessionKey = params.get("sessionKey") ?? "";
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  const force = params.get("force") === "1";
  // Absent = the preset's own default grouping; "none" = explicitly ungrouped.
  const groupByParam = params.get("groupBy");
  const effectiveGroupBy =
    groupByParam === null ? preset?.groupBy : groupByParam === "none" ? undefined : groupByParam;

  const paramValue = (name: string) => params.get(`p_${name}`) ?? "";

  const requestJson = useMemo(() => {
    if (!preset || symbol === "") return null;
    const req: PresetRunRequest = { presetId: preset.id, symbol, sessionsLimit: 50 };
    const values: Record<string, number | string> = {};
    for (const spec of preset.params) {
      const raw = paramValue(spec.name).trim();
      if (raw === "") continue;
      values[spec.name] = spec.type === "number" || spec.type === "duration" ? Number(raw) : raw;
    }
    if (Object.keys(values).length > 0) req.params = values;
    if (sessionKey !== "") req.sessionKey = sessionKey;
    if (since !== "") req.since = since;
    if (until !== "") req.until = until;
    if (groupByParam !== null) req.groupBy = groupByParam === "none" ? "" : groupByParam;
    if (force) req.force = true;
    return JSON.stringify(req);
    // params is a fresh URLSearchParams per navigation; its string form captures every p_ value.
  }, [preset, symbol, sessionKey, since, until, groupByParam, force, params.toString()]);

  if (!presets.loading && presets.data && preset === null) {
    return (
      <EmptyState title={`No preset named '${id}'`}>
        <p>
          The catalog is the <code>presets/</code> folder: this id isn't in it.{" "}
          <Link
            href="/"
            className="text-foreground underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
          >
            Back to the reports grid
          </Link>
          .
        </p>
      </EmptyState>
    );
  }

  return (
    <div>
      <Link
        href={`/?symbol=${encodeURIComponent(symbol)}`}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        all reports
      </Link>

      {preset === null ? (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-medium tracking-tight">{preset.title}</h1>
            <Badge tone="accent">{preset.category}</Badge>
            <Badge tone="dim">
              <span className="font-mono">v{preset.version}</span>
            </Badge>
          </div>
          <p className="mt-2.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {preset.summary}
          </p>
        </div>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Panel className="p-4 lg:sticky lg:top-20">
          <SectionLabel>Run against</SectionLabel>
          <div className="mt-3 space-y-3">
            <Labeled label="Symbol">
              <SelectInput ariaLabel="Symbol" value={symbol} onChange={(v) => patch({ symbol: v })}>
                {symbolList.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.symbol}
                  </option>
                ))}
              </SelectInput>
            </Labeled>
            <Labeled label="Session">
              <SelectInput
                ariaLabel="Session"
                value={sessionKey}
                onChange={(v) => patch({ sessionKey: v })}
              >
                <option value="">default</option>
                {(symbolConfig ? sessionKeysFor(symbolConfig) : []).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </SelectInput>
            </Labeled>
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="From">
                <TextInput
                  ariaLabel="From date"
                  type="date"
                  value={since}
                  onChange={(v) => patch({ since: v })}
                />
              </Labeled>
              <Labeled label="To">
                <TextInput
                  ariaLabel="To date"
                  type="date"
                  value={until}
                  onChange={(v) => patch({ until: v })}
                />
              </Labeled>
            </div>
            <Labeled label="Group by">
              <SelectInput
                ariaLabel="Group by"
                value={groupByParam ?? preset?.groupBy ?? "none"}
                onChange={(v) => patch({ groupBy: v })}
              >
                <option value="none">no grouping</option>
                {groupable.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </SelectInput>
            </Labeled>
          </div>

          {preset && preset.params.length > 0 ? (
            <>
              <div className="mt-5">
                <SectionLabel>Parameters</SectionLabel>
              </div>
              <div className="mt-3 space-y-3">
                {preset.params.map((spec) => (
                  <ParamControl
                    key={spec.name}
                    spec={spec}
                    value={paramValue(spec.name)}
                    onChange={(v) => patch({ [`p_${spec.name}`]: v })}
                  />
                ))}
              </div>
            </>
          ) : null}

          <div className="mt-5 flex items-center justify-between gap-2">
            <Button
              onClick={() => {
                const cleared: Record<string, string | null> = {
                  sessionKey: null,
                  since: null,
                  until: null,
                  groupBy: null,
                  force: null,
                };
                for (const spec of preset?.params ?? []) cleared[`p_${spec.name}`] = null;
                patch(cleared);
              }}
            >
              reset
            </Button>
            <span className="font-mono text-[10px] text-faint">every control lives in the URL</span>
          </div>
        </Panel>

        <div className="min-w-0">
          {requestJson !== null ? (
            <ReportRunner
              requestJson={requestJson}
              groupBy={effectiveGroupBy}
              onForce={() => patch({ force: "1" })}
            />
          ) : (
            <ResultsSkeleton />
          )}
        </div>
      </div>
    </div>
  );
}
