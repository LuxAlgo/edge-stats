/*
  '/builder': compose P(outcome | conditions) visually or as text. The
  live DSL string is always in view and is the same string the CLI and MCP
  server run. Full query state serializes into the URL, so every result is
  a reproducible permalink. A session-scoped counter nudges honestly when
  many variations have been tried (multiple comparisons).
*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { QueryRequest, QueryResult, RegistryArg, RegistryEntryDescription } from "../lib/api";
import { api, ApiError } from "../lib/api";
import type { BuilderState, CompareOp, ConditionRow } from "../lib/dsl";
import { composeDsl, defaultOpFor, emptyRow, freshId, opsFor } from "../lib/dsl";
import {
  DSL_FOCUS_EVENT,
  consumePendingDslFocus,
  useAsync,
  useCachedAsync,
  useDebounced,
  useUrlParams,
} from "../lib/hooks";
import { ResultsPanel, ResultsSkeleton } from "../components/results-panel";
import { sessionKeysFor } from "./report";
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorNote,
  Labeled,
  NativeSelect,
  Panel,
  SectionLabel,
  SelectInput,
  Skeleton,
  TextInput,
  inputClass,
} from "../components/ui";

/*
  Session-scoped (module-level) memory of distinct query variations run in
  the builder: the raw material for the multiple-comparisons nudge.
*/
const variationsTried = new Set<string>();
let nudgeDismissed = false;

const unitHint = (unit: string | undefined): string | null =>
  unit === "%" ? "%" : unit === "minutes" ? "min" : (unit ?? null);

function ArgInput({
  spec,
  value,
  onChange,
}: {
  spec: RegistryArg;
  value: string;
  onChange: (v: string) => void;
}) {
  const placeholder =
    spec.default !== undefined ? String(spec.default) : spec.required ? "required" : "optional";
  if (spec.type === "enum") {
    return (
      <NativeSelect
        aria-label={spec.name}
        title={spec.doc}
        className="w-auto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {spec.name}: {placeholder}
        </option>
        {(spec.values ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={spec.doc}>
      <input
        aria-label={spec.name}
        className={`${inputClass} stat w-24 font-mono text-xs`}
        type={spec.type === "string" ? "text" : "number"}
        value={value}
        placeholder={`${spec.name}${spec.default !== undefined ? ` (${placeholder})` : ""}`}
        onChange={(e) => onChange(e.target.value)}
      />
      {spec.type === "duration" ? <span className="text-xs text-muted-foreground">min</span> : null}
    </span>
  );
}

function NotToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={value}
      title="Negate this condition"
      onClick={() => onChange(!value)}
      className={`h-8 rounded-full border px-2.5 font-mono text-[11px] font-medium transition duration-150 active:scale-[0.98] ${
        value
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border text-faint hover:text-foreground"
      }`}
    >
      NOT
    </button>
  );
}

function ValueEditor({
  entry,
  row,
  onChange,
}: {
  entry: RegistryEntryDescription;
  row: ConditionRow;
  onChange: (next: ConditionRow) => void;
}) {
  if (entry.valueType === "boolean") {
    return (
      <SelectInput
        ariaLabel="boolean value"
        value={row.value === "false" ? "false" : "true"}
        onChange={(v) => onChange({ ...row, value: v })}
      >
        <option value="true">is true</option>
        <option value="false">is false</option>
      </SelectInput>
    );
  }

  const ops = opsFor(entry);
  const opSelect = (
    <NativeSelect
      aria-label="comparator"
      className="w-auto font-mono"
      value={row.op}
      onChange={(e) => onChange({ ...row, op: e.target.value as CompareOp })}
    >
      {ops.map((op) => (
        <option key={op} value={op}>
          {op === "between" ? "BETWEEN" : op === "in" ? "IN" : op}
        </option>
      ))}
    </NativeSelect>
  );

  if (entry.valueType === "enum") {
    if (row.op === "in") {
      const selected = new Set(row.values);
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {opSelect}
          {(entry.enumValues ?? []).map((v) => {
            const on = selected.has(v);
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(v);
                  else next.add(v);
                  onChange({
                    ...row,
                    values: (entry.enumValues ?? []).filter((x) => next.has(x)),
                  });
                }}
                className={`rounded-full border px-2.5 py-1 text-xs transition duration-150 active:scale-[0.98] ${
                  on
                    ? "border-chart-1/40 bg-chart-1/10 text-chart-1"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {v}
              </button>
            );
          })}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        {opSelect}
        <NativeSelect
          aria-label="value"
          className="w-auto"
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
        >
          <option value="">choose…</option>
          {(entry.enumValues ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </span>
    );
  }

  const unit = unitHint(entry.unit);
  return (
    <span className="inline-flex items-center gap-1.5">
      {opSelect}
      <input
        aria-label="value"
        className={`${inputClass} stat w-24 font-mono text-xs`}
        type="number"
        step="any"
        value={row.value}
        placeholder="value"
        onChange={(e) => onChange({ ...row, value: e.target.value })}
      />
      {row.op === "between" ? (
        <>
          <span className="text-xs text-muted-foreground">and</span>
          <input
            aria-label="upper value"
            className={`${inputClass} stat w-24 font-mono text-xs`}
            type="number"
            step="any"
            value={row.valueHi}
            placeholder="value"
            onChange={(e) => onChange({ ...row, valueHi: e.target.value })}
          />
        </>
      ) : null}
      {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
    </span>
  );
}

function RowEditor({
  row,
  predicates,
  fields,
  byName,
  onChange,
  onRemove,
}: {
  row: ConditionRow;
  predicates: RegistryEntryDescription[];
  fields: RegistryEntryDescription[];
  byName: Map<string, RegistryEntryDescription>;
  onChange: (next: ConditionRow) => void;
  onRemove: () => void;
}) {
  const entry = byName.get(row.name);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
      <NotToggle value={row.not} onChange={(v) => onChange({ ...row, not: v })} />
      <NativeSelect
        aria-label="condition"
        className="w-auto max-w-[220px]"
        value={row.name}
        onChange={(e) => {
          const name = e.target.value;
          const nextEntry = byName.get(name);
          onChange({
            ...emptyRow(name),
            id: row.id,
            not: row.not,
            op: defaultOpFor(nextEntry),
          });
        }}
      >
        <option value="">choose a condition…</option>
        <optgroup label="Setup predicates">
          {predicates.map((p) => (
            <option key={p.name} value={p.name} title={p.doc}>
              {p.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Field comparisons">
          {fields.map((f) => (
            <option key={f.name} value={f.name} title={f.doc}>
              {f.name}
            </option>
          ))}
        </optgroup>
      </NativeSelect>

      {entry && entry.kind === "predicate"
        ? (entry.args ?? []).map((spec) => (
            <ArgInput
              key={spec.name}
              spec={spec}
              value={row.args[spec.name] ?? ""}
              onChange={(v) => onChange({ ...row, args: { ...row.args, [spec.name]: v } })}
            />
          ))
        : null}
      {entry && entry.kind === "field" ? (
        <ValueEditor entry={entry} row={row} onChange={onChange} />
      ) : null}

      {entry ? (
        <span
          className="hidden max-w-[260px] truncate text-[11px] text-muted-foreground xl:inline"
          title={entry.doc}
        >
          {entry.doc}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="remove condition"
        onClick={onRemove}
        className="ml-auto rounded-full p-1.5 text-faint transition-colors duration-150 hover:bg-white/[0.04] hover:text-destructive"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function MultipleComparisonsNote({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-warning/25 bg-warning/10 p-3 text-sm">
      <div>
        <span className="font-medium text-warning">{count} query variations this session.</span>{" "}
        <span className="text-muted-foreground">
          Trying many cuts inflates the chance that one shows a spurious edge: that is how multiple
          comparisons work, not a property of your market. The honest moves: decide the cut before
          looking, and only trust numbers whose two halves agree in the stability split.
        </span>
      </div>
      <Button onClick={onDismiss}>dismiss</Button>
    </div>
  );
}

interface CurrentRun {
  dsl: string;
  force: boolean;
  /** Bumped by the explicit run button so identical text re-executes. */
  nonce?: number;
}

export function BuilderPage() {
  const { params, patch } = useUrlParams();
  const registry = useCachedAsync("registry", (signal) => api.registry(signal));
  const symbols = useCachedAsync("symbols", (signal) => api.symbols(signal));

  const entries = registry.data?.entries ?? [];
  const outcomes = useMemo(() => entries.filter((e) => e.kind === "outcome"), [entries]);
  const predicates = useMemo(() => entries.filter((e) => e.kind === "predicate"), [entries]);
  const fields = useMemo(() => entries.filter((e) => e.kind === "field"), [entries]);
  const groupable = useMemo(() => fields.filter((f) => f.groupable === true), [fields]);
  const byName = useMemo(() => new Map(entries.map((e) => [e.name, e])), [entries]);

  const symbolList = symbols.data?.symbols ?? [];
  const symbol = params.get("symbol") ?? symbolList[0]?.symbol ?? "";
  const symbolConfig = symbolList.find((s) => s.symbol === symbol) ?? null;
  const sessionKey = params.get("sessionKey") ?? "";
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  const groupBy = params.get("groupBy") ?? "";

  const initialDsl = useRef(params.get("dsl"));
  const [mode, setMode] = useState<"visual" | "text">(
    initialDsl.current !== null ? "text" : "visual",
  );
  const [text, setText] = useState(initialDsl.current ?? "");
  const [builder, setBuilder] = useState<BuilderState>(() => ({
    outcome: { name: "", args: {} },
    rows: [],
    groups: [],
  }));
  const [current, setCurrent] = useState<CurrentRun | null>(
    initialDsl.current !== null ? { dsl: initialDsl.current, force: false } : null,
  );
  const [variations, setVariations] = useState(variationsTried.size);
  const [nudgeHidden, setNudgeHidden] = useState(nudgeDismissed);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Default the outcome once the registry arrives.
  useEffect(() => {
    if (builder.outcome.name !== "" || outcomes.length === 0) return;
    const preferred = outcomes.find((o) => o.name === "gapFill") ?? outcomes[0];
    if (preferred) setBuilder((b) => ({ ...b, outcome: { name: preferred.name, args: {} } }));
  }, [outcomes, builder.outcome.name]);

  const composed = useMemo(() => composeDsl(builder, byName), [builder, byName]);
  const liveDsl = mode === "text" ? text : (composed.dsl ?? "");

  // '/' focuses the DSL box (switching to text mode, seeded from the composer).
  const focusDslBox = useCallback(() => {
    setMode((m) => {
      if (m === "visual") setText((t) => (t.trim() === "" ? (composed.dsl ?? "") : t));
      return "text";
    });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [composed.dsl]);
  useEffect(() => {
    if (consumePendingDslFocus()) focusDslBox();
    window.addEventListener(DSL_FOCUS_EVENT, focusDslBox);
    return () => window.removeEventListener(DSL_FOCUS_EVENT, focusDslBox);
  }, [focusDslBox]);

  // Visual mode auto-runs complete queries (debounced), so composing feels live.
  const debouncedComposed = useDebounced(composed.dsl, 500);
  useEffect(() => {
    if (mode !== "visual" || debouncedComposed === null || symbol === "") return;
    setCurrent((c) =>
      c?.dsl === debouncedComposed ? c : { dsl: debouncedComposed, force: false },
    );
  }, [mode, debouncedComposed, symbol]);

  // Permalink: the executed query state lives in the URL, and each distinct
  // variation is remembered for the multiple-comparisons nudge.
  useEffect(() => {
    if (current === null || symbol === "") return;
    const desired: Record<string, string | null> = {
      dsl: current.dsl,
      symbol,
      sessionKey: sessionKey === "" ? null : sessionKey,
      since: since === "" ? null : since,
      until: until === "" ? null : until,
      groupBy: groupBy === "" ? null : groupBy,
    };
    const dirty = Object.entries(desired).some(([k, v]) => (params.get(k) ?? null) !== v);
    if (dirty) patch(desired);
    variationsTried.add(JSON.stringify([current.dsl, symbol, sessionKey, since, until, groupBy]));
    setVariations(variationsTried.size);
  }, [current, symbol, sessionKey, since, until, groupBy, patch, params]);

  const runKey =
    current === null ? null : JSON.stringify([current, symbol, sessionKey, since, until, groupBy]);
  const run = useAsync<QueryResult | null>(
    async (signal) => {
      if (current === null || symbol === "") return null;
      const req: QueryRequest = { dsl: current.dsl, symbol, sessionsLimit: 50 };
      if (sessionKey !== "") req.sessionKey = sessionKey;
      if (since !== "") req.since = since;
      if (until !== "") req.until = until;
      if (groupBy !== "") req.groupBy = groupBy;
      if (current.force) req.force = true;
      return api.query(req, signal);
    },
    [runKey],
  );

  const runText = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setCurrent({ dsl: trimmed, force: false, nonce: Date.now() });
  }, [text]);

  const permalink = useMemo(() => {
    if (current === null) return null;
    const q = new URLSearchParams();
    q.set("dsl", current.dsl);
    if (symbol !== "") q.set("symbol", symbol);
    if (sessionKey !== "") q.set("sessionKey", sessionKey);
    if (since !== "") q.set("since", since);
    if (until !== "") q.set("until", until);
    if (groupBy !== "") q.set("groupBy", groupBy);
    return `${window.location.origin}/builder?${q.toString()}`;
  }, [current, symbol, sessionKey, since, until, groupBy]);

  // A submitted text query that failed to parse: caret under the exact offset.
  const parseError =
    run.error instanceof ApiError && run.error.position !== null && current !== null
      ? { err: run.error, dsl: current.dsl }
      : null;

  const outcomeEntry = byName.get(builder.outcome.name);

  return (
    <div>
      <h1 className="text-2xl font-medium tracking-tight">Query builder</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Ask P(outcome | conditions) in any combination the registry knows. The DSL string below is
        live: copy it and the exact same query runs in the CLI and over MCP.
      </p>

      {variations > 10 && !nudgeHidden ? (
        <div className="mt-4">
          <MultipleComparisonsNote
            count={variations}
            onDismiss={() => {
              nudgeDismissed = true;
              setNudgeHidden(true);
            }}
          />
        </div>
      ) : null}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        {/* Composer */}
        <div className="min-w-0 space-y-4">
          <Panel className="p-4">
            <SectionLabel>Outcome: the question</SectionLabel>
            {registry.loading ? (
              <Skeleton className="mt-3 h-8 w-64" />
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <NativeSelect
                  aria-label="outcome"
                  className="w-auto max-w-[240px]"
                  value={builder.outcome.name}
                  onChange={(e) =>
                    setBuilder((b) => ({ ...b, outcome: { name: e.target.value, args: {} } }))
                  }
                >
                  {outcomes.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
                {(outcomeEntry?.args ?? []).map((spec) => (
                  <ArgInput
                    key={spec.name}
                    spec={spec}
                    value={builder.outcome.args[spec.name] ?? ""}
                    onChange={(v) =>
                      setBuilder((b) => ({
                        ...b,
                        outcome: { ...b.outcome, args: { ...b.outcome.args, [spec.name]: v } },
                      }))
                    }
                  />
                ))}
              </div>
            )}
            {outcomeEntry ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {outcomeEntry.doc}
              </p>
            ) : null}
            {outcomeEntry?.valueDoc ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Also measures: {outcomeEntry.valueDoc}
                {outcomeEntry.valueUnit ? ` (${outcomeEntry.valueUnit})` : ""}
              </p>
            ) : null}
          </Panel>

          <Panel className="p-4">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Conditions: all must hold (AND)</SectionLabel>
              <span className="text-[11px] text-muted-foreground">
                {builder.rows.length === 0 && builder.groups.length === 0
                  ? "unconditioned"
                  : `${composed.incompleteRows > 0 ? `${composed.incompleteRows} incomplete · ` : ""}NULLs count as false`}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {builder.rows.map((row) => (
                <RowEditor
                  key={row.id}
                  row={row}
                  predicates={predicates}
                  fields={fields}
                  byName={byName}
                  onChange={(next) =>
                    setBuilder((b) => ({
                      ...b,
                      rows: b.rows.map((r) => (r.id === row.id ? next : r)),
                    }))
                  }
                  onRemove={() =>
                    setBuilder((b) => ({ ...b, rows: b.rows.filter((r) => r.id !== row.id) }))
                  }
                />
              ))}
              {builder.rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No conditions yet: the outcome runs over every eligible session. Add a condition
                  to slice the denominator.
                </p>
              ) : null}
            </div>

            {builder.groups.map((group, gi) => (
              <div key={group.id} className="mt-3 rounded-lg border border-white/[0.08] p-3">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel>OR group {gi + 1}: any may hold</SectionLabel>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground transition hover:text-destructive"
                    onClick={() =>
                      setBuilder((b) => ({
                        ...b,
                        groups: b.groups.filter((g) => g.id !== group.id),
                      }))
                    }
                  >
                    remove group
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {group.rows.map((row) => (
                    <RowEditor
                      key={row.id}
                      row={row}
                      predicates={predicates}
                      fields={fields}
                      byName={byName}
                      onChange={(next) =>
                        setBuilder((b) => ({
                          ...b,
                          groups: b.groups.map((g) =>
                            g.id === group.id
                              ? { ...g, rows: g.rows.map((r) => (r.id === row.id ? next : r)) }
                              : g,
                          ),
                        }))
                      }
                      onRemove={() =>
                        setBuilder((b) => ({
                          ...b,
                          groups: b.groups.map((g) =>
                            g.id === group.id
                              ? { ...g, rows: g.rows.filter((r) => r.id !== row.id) }
                              : g,
                          ),
                        }))
                      }
                    />
                  ))}
                </div>
                <div className="mt-2">
                  <Button
                    onClick={() =>
                      setBuilder((b) => ({
                        ...b,
                        groups: b.groups.map((g) =>
                          g.id === group.id ? { ...g, rows: [...g.rows, emptyRow()] } : g,
                        ),
                      }))
                    }
                  >
                    + OR alternative
                  </Button>
                </div>
              </div>
            ))}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setBuilder((b) => ({ ...b, rows: [...b.rows, emptyRow()] }))}>
                + condition
              </Button>
              <Button
                onClick={() =>
                  setBuilder((b) => ({
                    ...b,
                    groups: [...b.groups, { id: freshId(), rows: [emptyRow()] }],
                  }))
                }
                title="Conditions inside a group are OR'ed; the group AND's into the rest"
              >
                + OR group
              </Button>
            </div>
          </Panel>
        </div>

        {/* Context + the live DSL */}
        <div className="space-y-4 lg:sticky lg:top-20">
          <Panel className="p-4">
            <SectionLabel>Run against</SectionLabel>
            <div className="mt-3 space-y-3">
              <Labeled label="Symbol">
                <SelectInput
                  ariaLabel="Symbol"
                  value={symbol}
                  onChange={(v) => patch({ symbol: v })}
                >
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
                  value={groupBy}
                  onChange={(v) => patch({ groupBy: v })}
                >
                  <option value="">no grouping</option>
                  {groupable.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </SelectInput>
              </Labeled>
            </div>
          </Panel>

          <Panel className="p-4">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Query DSL</SectionLabel>
              <button
                type="button"
                className="text-xs text-muted-foreground underline decoration-white/20 underline-offset-4 transition-colors duration-150 hover:text-foreground"
                onClick={() => {
                  if (mode === "visual") focusDslBox();
                  else setMode("visual");
                }}
              >
                {mode === "visual" ? "edit as text" : "back to composer"}
              </button>
            </div>

            {mode === "visual" ? (
              <code className="stat mt-3 block min-h-[3.5rem] overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.08] bg-black/60 p-3 font-mono text-xs leading-relaxed">
                {composed.dsl ?? (
                  <span className="text-muted-foreground">
                    finish the outcome's required arguments to form a query…
                  </span>
                )}
              </code>
            ) : (
              <>
                <textarea
                  ref={textareaRef}
                  aria-label="Query DSL"
                  rows={3}
                  spellCheck={false}
                  className="stat mt-3 w-full resize-y rounded-lg border border-border bg-white/[0.03] p-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-faint transition-colors duration-150 hover:border-white/20 focus:border-white/30 focus:outline-none"
                  placeholder="gapFill WHERE dayOfWeek = Tue AND absGapPct >= 0.3"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      runText();
                    }
                  }}
                />
                <p className="mt-1.5 text-[11px] text-faint">
                  text edits don't flow back into the composer: this box is the query now
                </p>
              </>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {mode === "text" ? (
                <Button variant="primary" onClick={runText} title="Ctrl/⌘ + Enter">
                  run
                </Button>
              ) : null}
              {liveDsl.trim() !== "" ? (
                <CopyButton text={liveDsl} caption="runs in the CLI and MCP too" />
              ) : null}
            </div>
            {permalink !== null ? (
              <div className="mt-2 flex items-center gap-2">
                <CopyButton text={permalink} caption="permalink: reruns this exact query" />
              </div>
            ) : null}
            <p className="stat mt-3 font-mono text-[11px] text-faint">
              {variations} variation{variations === 1 ? "" : "s"} tried this session
            </p>
          </Panel>
        </div>
      </div>

      {/* Results */}
      <div className="mt-8">
        {parseError !== null ? (
          <Panel className="p-4">
            <SectionLabel>The engine could not parse that</SectionLabel>
            <pre className="stat mt-3 overflow-x-auto rounded-lg border border-destructive/30 bg-black/60 p-3 font-mono text-xs leading-relaxed">
              {parseError.dsl}
              {"\n"}
              <span className="text-destructive">
                {" ".repeat(Math.max(0, parseError.err.position ?? 0)) +
                  "^".repeat(Math.max(1, parseError.err.length ?? 1))}
              </span>
            </pre>
            <p className="mt-2 text-sm text-destructive">{parseError.err.message}</p>
            {parseError.err.hint ? (
              <p className="mt-1 text-sm text-muted-foreground">hint: {parseError.err.hint}</p>
            ) : null}
          </Panel>
        ) : run.error ? (
          <ErrorNote error={run.error} />
        ) : current !== null && run.loading ? (
          <ResultsSkeleton />
        ) : run.data ? (
          <ResultsPanel
            result={run.data}
            groupBy={groupBy === "" ? undefined : groupBy}
            onForce={() => setCurrent((c) => (c === null ? c : { ...c, force: true }))}
            openSession={openSession}
            onOpenSession={setOpenSession}
            onCloseSession={() => setOpenSession(null)}
          />
        ) : (
          <EmptyState title="Compose a query to see results">
            <p>
              Pick the outcome (the question), add conditions (the denominator you actually care
              about), and the result arrives with N, a 95% interval, a stability split, and the
              sessions behind it. Nothing here predicts anything: it counts what happened.
            </p>
          </EmptyState>
        )}
      </div>
    </div>
  );
}
