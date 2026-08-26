/*
  The shared results panel: every envelope: preset runs and built queries
  alike: renders here, so the honesty layer (N + CI everywhere, guards,
  stability split, recency, per-year counts, the verbatim disclaimer)
  appears identically on every page.
*/
import { useEffect } from "react";
import type { ReactNode } from "react";
import type { QueryResult, SessionDetail } from "../lib/api";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { fmtInt, fmtNum, fmtValue } from "../lib/format";
import { CiBar, PercentileStrip, YearBars } from "./charts";
import { Estimate, EstimateInline } from "./estimate";
import {
  Badge,
  Button,
  ErrorNote,
  LowSampleBadge,
  Panel,
  SectionLabel,
  Skeleton,
  StabilityTick,
} from "./ui";

function PanelBlock({
  label,
  children,
  aside,
}: {
  label: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Panel className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

function GuardBanner({ result, onForce }: { result: QueryResult; onForce?: () => void }) {
  const { guards, estimate, n } = result;
  if (guards.refused && estimate === null) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel-2 p-3 text-sm">
        <span className="text-dim">
          Estimate withheld: <span className="stat text-ink">{fmtInt(n)}</span> matched sessions is
          below the refuse floor of {guards.refuseFloor}. Counts stay visible; the rate does not.
        </span>
        {onForce ? (
          <Button onClick={onForce} title="Same as --force in the CLI: the banner stays">
            reveal anyway
          </Button>
        ) : null}
      </div>
    );
  }
  if (guards.refused) {
    return (
      <div className="rounded-lg border border-neg/40 bg-neg/10 p-3 text-sm text-neg">
        Below the refuse floor ({guards.refuseFloor}): revealed by force. Treat this as an anecdote,
        not a statistic.
      </div>
    );
  }
  if (guards.lowSample) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
        <LowSampleBadge />
        <span>
          Fewer than {guards.warnFloor} matched sessions: the interval is wide for a reason.
        </span>
      </div>
    );
  }
  return null;
}

function StabilityBlock({ result }: { result: QueryResult }) {
  const s = result.stability;
  return (
    <PanelBlock
      label="Stability: first half vs second half"
      aside={<StabilityTick agree={s?.agree ?? null} />}
    >
      {s === null ? (
        <p className="text-sm text-dim">No matched sessions to split.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["First half", s.firstHalf],
              ["Second half", s.secondHalf],
            ] as const
          ).map(([label, half]) => (
            <div key={label}>
              <Estimate
                size="sm"
                label={label}
                facts={{ estimate: half.estimate, ci95: half.ci95, n: half.n }}
              />
              <div className="mt-2">
                <CiBar estimate={half.estimate} ci95={half.ci95} tone="accent" />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-dim">
        The matched sessions, split chronologically in half. Overlapping intervals mean the two eras
        are statistically compatible: an edge that only exists in one half is not an edge.
      </p>
    </PanelBlock>
  );
}

function RecencyBlock({ result }: { result: QueryResult }) {
  const r = result.recency;
  return (
    <PanelBlock label="Recency vs all history">
      {r === null ? (
        <p className="text-sm text-dim">
          The recency window covers every matched session, so there is nothing separate to compare.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Estimate
                size="sm"
                label="All history"
                facts={{ estimate: result.estimate, ci95: result.ci95, n: result.n }}
              />
              <div className="mt-2">
                <CiBar estimate={result.estimate} ci95={result.ci95} tone="accent" />
              </div>
            </div>
            <div>
              <Estimate
                size="sm"
                label={`Last ${fmtInt(r.window)} sessions`}
                facts={{ estimate: r.estimate, ci95: r.ci95, n: r.n }}
              />
              <div className="mt-2">
                <CiBar estimate={r.estimate} ci95={r.ci95} tone="violet" />
              </div>
            </div>
          </div>
          {r.diverges === true ? (
            <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
              The recent window diverges from all history: the two intervals do not overlap.
              Whatever this measured, it has not been behaving the same way lately.
            </div>
          ) : r.diverges === false ? (
            <p className="mt-3 text-xs text-dim">
              Recent behavior is consistent with the full history (intervals overlap).
            </p>
          ) : null}
        </>
      )}
    </PanelBlock>
  );
}

function GroupsBlock({ result, groupBy }: { result: QueryResult; groupBy?: string }) {
  const groups = result.groups;
  if (groups === null) return null;
  return (
    <PanelBlock label={groupBy ? `Grouped by ${groupBy}` : "Groups"}>
      {groups.length === 0 ? (
        <p className="text-sm text-dim">No groups matched.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-dim">
                <th className="pb-2 pr-3 font-medium">Group</th>
                <th className="pb-2 pr-3 font-medium">Estimate · 95% CI</th>
                <th className="w-[38%] pb-2 font-medium">Interval</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group} className="border-t border-line/60">
                  <td className="stat py-2 pr-3 font-medium">{g.group}</td>
                  <td className="py-2 pr-3">
                    <EstimateInline
                      facts={{ estimate: g.estimate, ci95: g.ci95, n: g.n, lowSample: g.lowSample }}
                    />
                  </td>
                  <td className="py-2">
                    <CiBar estimate={g.estimate} ci95={g.ci95} height={12} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelBlock>
  );
}

function SessionValue({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) return <span className="text-dim">—</span>;
  return <span className="stat">{fmtValue(value, unit)}</span>;
}

export function SessionDrawer({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(
    (signal) => api.sessions([sessionId], signal),
    [sessionId],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const detail: SessionDetail | null = data?.sessions[0] ?? null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 w-full max-w-[460px] overflow-y-auto border-l border-line bg-panel p-5"
        role="dialog"
        aria-label="Session features"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <SectionLabel>Session drill-down</SectionLabel>
            <div className="stat mt-1 break-all font-mono text-sm">{sessionId}</div>
          </div>
          <Button onClick={onClose}>close</Button>
        </div>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorNote error={error} />
        ) : detail === null ? (
          <p className="text-sm text-dim">Session not found in the store.</p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[13px]">
            {Object.entries(detail.features)
              .filter(([k]) => k !== "session_id")
              .map(([key, value]) => (
                <FeatureRow key={key} name={key} value={value} />
              ))}
          </dl>
        )}
        <p className="mt-5 text-xs leading-relaxed text-dim">
          Every derived feature for this session: the exact row the query engine matched. The same
          row backs the CLI, the MCP tools, and every report.
        </p>
      </aside>
    </>
  );
}

function FeatureRow({ name, value }: { name: string; value: unknown }) {
  let rendered: ReactNode;
  if (value === null || value === undefined) rendered = <span className="text-dim">—</span>;
  else if (typeof value === "boolean")
    rendered = <Badge tone={value ? "green" : "dim"}>{value ? "true" : "false"}</Badge>;
  else if (typeof value === "number") rendered = <span className="stat">{fmtNum(value, 4)}</span>;
  else rendered = <span className="stat">{String(value)}</span>;
  return (
    <>
      <dt className="truncate font-mono text-dim" title={name}>
        {name}
      </dt>
      <dd className="text-right">{rendered}</dd>
    </>
  );
}

function SessionsBlock({
  result,
  onOpenSession,
}: {
  result: QueryResult;
  onOpenSession: (id: string) => void;
}) {
  const unit = result.distribution?.unit ?? "";
  return (
    <PanelBlock
      label={`Matching sessions: most recent ${fmtInt(result.sessions.length)} of ${fmtInt(result.n)}`}
    >
      {result.sessions.length === 0 ? (
        <p className="text-sm text-dim">No matching sessions to list.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-dim">
                <th className="pb-2 pr-3 font-medium">Trade date</th>
                <th className="pb-2 pr-3 font-medium">Outcome</th>
                <th className="pb-2 pr-3 font-medium">Value{unit ? ` (${unit})` : ""}</th>
                <th className="pb-2 font-medium" aria-label="details" />
              </tr>
            </thead>
            <tbody>
              {result.sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  tabIndex={0}
                  className="cursor-pointer border-t border-line/60 transition hover:bg-panel-2"
                  onClick={() => onOpenSession(s.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenSession(s.sessionId);
                    }
                  }}
                >
                  <td className="stat py-2 pr-3">{s.tradeDate}</td>
                  <td className="py-2 pr-3">
                    {s.success ? <Badge tone="green">hit</Badge> : <Badge tone="red">miss</Badge>}
                  </td>
                  <td className="py-2 pr-3">
                    <SessionValue value={s.value} unit={unit} />
                  </td>
                  <td className="py-2 text-right text-xs text-dim">features →</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelBlock>
  );
}

/** The envelope's own words and provenance — sticky under every results view. */
export function EnvelopeFooter({ result }: { result: QueryResult }) {
  return (
    <div className="sticky bottom-0 z-30 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-t-lg border border-line bg-bg/90 px-4 py-2.5 backdrop-blur">
        <span className="text-[11px] italic text-dim">{result.disclaimer}</span>
        <span className="stat font-mono text-[10px] text-dim/80">
          engine v{result.engine.version} · store {result.engine.storeFingerprint} · calendar{" "}
          {result.engine.calendarVersion}
        </span>
      </div>
    </div>
  );
}

export function ResultsPanel({
  result,
  groupBy,
  onForce,
  openSession,
  onOpenSession,
  onCloseSession,
}: {
  result: QueryResult;
  /** The groupable field the caller grouped by, for the groups table label. */
  groupBy?: string;
  onForce?: () => void;
  openSession: string | null;
  onOpenSession: (id: string) => void;
  onCloseSession: () => void;
}) {
  // Refused and not forced: the engine withheld the estimate, so the panel
  // withholds every aggregate view too — counts and raw sessions only. A
  // "N too small" headline next to a 100% stability half would be a leak.
  const withheld = result.guards.refused && result.estimate === null;
  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <Estimate
            size="xl"
            facts={{
              estimate: result.estimate,
              ci95: result.ci95,
              n: result.n,
              lowSample: result.guards.lowSample,
            }}
          />
          <div className="min-w-0 max-w-full space-y-2 text-right">
            <SectionLabel>As the engine understood it</SectionLabel>
            <code className="block max-w-full overflow-x-auto whitespace-nowrap rounded-md border border-line bg-panel-2 px-2 py-1.5 text-left font-mono text-xs">
              {result.query.dsl}
            </code>
            <div className="stat flex flex-wrap justify-end gap-1.5 text-[11px] text-dim">
              <Badge>{result.query.symbol}</Badge>
              <Badge>session {result.query.sessionKey}</Badge>
              {result.query.since ? <Badge>from {result.query.since}</Badge> : null}
              {result.query.until ? <Badge>to {result.query.until}</Badge> : null}
            </div>
          </div>
        </div>
        <div className="stat mt-3 text-sm text-dim">
          {fmtInt(result.successes)} hits across {fmtInt(result.n)} matched sessions
        </div>
        <div className="mt-3">
          <GuardBanner result={result} onForce={onForce} />
        </div>
      </Panel>

      {withheld ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          <StabilityBlock result={result} />
          <RecencyBlock result={result} />
          <PanelBlock label="Per-year counts">
            {result.perYear.length === 0 ? (
              <p className="text-sm text-dim">
                No sessions matched, so there are no years to show.
              </p>
            ) : (
              <YearBars perYear={result.perYear} />
            )}
            <p className="mt-2 text-xs text-dim">
              Bar height is that year's hit rate; every bar carries its own N.
            </p>
          </PanelBlock>
          {result.distribution ? (
            <PanelBlock
              label={`Value distribution${result.distribution.unit ? `: ${result.distribution.unit}` : ""}`}
              aside={
                <span className="stat text-xs text-dim">
                  {fmtInt(result.distribution.count)} values · mean{" "}
                  {fmtValue(result.distribution.mean, result.distribution.unit)}
                </span>
              }
            >
              <PercentileStrip dist={result.distribution} />
            </PanelBlock>
          ) : null}
        </div>
      )}

      {withheld ? null : <GroupsBlock result={result} groupBy={groupBy} />}
      <SessionsBlock result={result} onOpenSession={onOpenSession} />
      <EnvelopeFooter result={result} />
      {openSession !== null ? (
        <SessionDrawer sessionId={openSession} onClose={onCloseSession} />
      ) : null}
    </div>
  );
}

/** Skeleton mirroring the results panel while a query is in flight. */
export function ResultsSkeleton() {
  return (
    <div className="space-y-4" aria-label="loading results" role="status">
      <Panel className="p-5">
        <Skeleton className="h-12 w-44" />
        <Skeleton className="mt-3 h-4 w-64" />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-16 w-full" />
        </Panel>
        <Panel className="p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-16 w-full" />
        </Panel>
      </div>
      <Panel className="p-4">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="mt-4 h-28 w-full" />
      </Panel>
    </div>
  );
}
