/*
  The shared results panel: every envelope: preset runs and built queries
  alike: renders here, so the honesty layer (N + CI everywhere, guards,
  stability split, recency, per-year counts, the verbatim disclaimer)
  appears identically on every page.
*/
import { useEffect } from "react";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
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
  PanelHeader,
  Skeleton,
  StabilityTick,
  tableHeadClass,
} from "./ui";

function PanelBlock({
  label,
  children,
  aside,
  footnote,
}: {
  label: string;
  children: ReactNode;
  aside?: ReactNode;
  footnote?: string;
}) {
  return (
    <Panel>
      <PanelHeader right={aside}>{label}</PanelHeader>
      <div className="p-4">{children}</div>
      {footnote ? (
        <p className="border-t border-white/[0.06] px-4 py-2.5 text-xs leading-relaxed text-faint">
          {footnote}
        </p>
      ) : null}
    </Panel>
  );
}

function GuardBanner({ result, onForce }: { result: QueryResult; onForce?: () => void }) {
  const { guards, estimate, n } = result;
  if (guards.refused && estimate === null) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white/[0.03] p-3 text-sm">
        <span className="text-muted-foreground">
          Estimate withheld: <span className="stat font-mono text-foreground">{fmtInt(n)}</span>{" "}
          matched sessions is below the refuse floor of {guards.refuseFloor}. Counts stay visible;
          the rate does not.
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
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        Below the refuse floor ({guards.refuseFloor}): revealed by force. Treat this as an anecdote,
        not a statistic.
      </div>
    );
  }
  if (guards.lowSample) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-warning/25 bg-warning/10 p-3 text-sm text-warning">
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
      label="stability · first half vs second half"
      aside={<StabilityTick agree={s?.agree ?? null} />}
      footnote="The matched sessions, split chronologically in half. Overlapping intervals mean the two eras are statistically compatible: an edge that only exists in one half is not an edge."
    >
      {s === null ? (
        <p className="text-sm text-muted-foreground">No matched sessions to split.</p>
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
              <div className="mt-2.5">
                <CiBar estimate={half.estimate} ci95={half.ci95} tone="accent" />
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelBlock>
  );
}

function RecencyBlock({ result }: { result: QueryResult }) {
  const r = result.recency;
  return (
    <PanelBlock label="recency vs all history">
      {r === null ? (
        <p className="text-sm text-muted-foreground">
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
              <div className="mt-2.5">
                <CiBar estimate={result.estimate} ci95={result.ci95} tone="accent" />
              </div>
            </div>
            <div>
              <Estimate
                size="sm"
                label={`Last ${fmtInt(r.window)} sessions`}
                facts={{ estimate: r.estimate, ci95: r.ci95, n: r.n }}
              />
              <div className="mt-2.5">
                <CiBar estimate={r.estimate} ci95={r.ci95} tone="accent" />
              </div>
            </div>
          </div>
          {r.diverges === true ? (
            <div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 p-3 text-sm text-warning">
              The recent window diverges from all history: the two intervals do not overlap.
              Whatever this measured, it has not been behaving the same way lately.
            </div>
          ) : r.diverges === false ? (
            <p className="mt-4 text-xs text-faint">
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
    <PanelBlock label={groupBy ? `grouped by ${groupBy}` : "groups"}>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No groups matched.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={tableHeadClass}>Group</th>
                <th className={tableHeadClass}>Estimate · 95% CI</th>
                <th className={`${tableHeadClass} w-[38%] pr-0`}>Interval</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group} className="border-t border-white/[0.06]">
                  <td className="stat py-2.5 pr-3 font-mono text-[13px]">{g.group}</td>
                  <td className="py-2.5 pr-3">
                    <EstimateInline
                      facts={{ estimate: g.estimate, ci95: g.ci95, n: g.n, lowSample: g.lowSample }}
                    />
                  </td>
                  <td className="py-2.5">
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
  if (value === null) return <span className="text-faint">—</span>;
  return <span className="stat font-mono text-[13px]">{fmtValue(value, unit)}</span>;
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
      <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 w-full max-w-[460px] overflow-y-auto border-l border-border bg-popover p-5"
        role="dialog"
        aria-label="Session features"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
              Session drill-down
            </div>
            <div className="stat mt-1.5 break-all font-mono text-sm">{sessionId}</div>
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
          <p className="text-sm text-muted-foreground">Session not found in the store.</p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[13px]">
            {Object.entries(detail.features)
              .filter(([k]) => k !== "session_id")
              .map(([key, value]) => (
                <FeatureRow key={key} name={key} value={value} />
              ))}
          </dl>
        )}
        <p className="mt-5 text-xs leading-relaxed text-faint">
          Every derived feature for this session: the exact row the query engine matched. The same
          row backs the CLI, the MCP tools, and every report.
        </p>
      </aside>
    </>
  );
}

function FeatureRow({ name, value }: { name: string; value: unknown }) {
  let rendered: ReactNode;
  if (value === null || value === undefined) rendered = <span className="text-faint">—</span>;
  else if (typeof value === "boolean")
    rendered = <Badge tone={value ? "green" : "dim"}>{value ? "true" : "false"}</Badge>;
  else if (typeof value === "number")
    rendered = <span className="stat font-mono">{fmtNum(value, 4)}</span>;
  else rendered = <span className="stat font-mono">{String(value)}</span>;
  return (
    <>
      <dt className="truncate font-mono text-muted-foreground" title={name}>
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
      label={`matching sessions · most recent ${fmtInt(result.sessions.length)} of ${fmtInt(result.n)}`}
    >
      {result.sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching sessions to list.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={tableHeadClass}>Trade date</th>
                <th className={tableHeadClass}>Outcome</th>
                <th className={tableHeadClass}>Value{unit ? ` (${unit})` : ""}</th>
                <th className={`${tableHeadClass} pr-0`} aria-label="details" />
              </tr>
            </thead>
            <tbody>
              {result.sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  tabIndex={0}
                  className="group cursor-pointer border-t border-white/[0.06] transition-colors duration-150 hover:bg-white/[0.03]"
                  onClick={() => onOpenSession(s.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenSession(s.sessionId);
                    }
                  }}
                >
                  <td className="stat py-2.5 pr-3 font-mono text-[13px]">{s.tradeDate}</td>
                  <td className="py-2.5 pr-3">
                    {s.success ? <Badge tone="green">hit</Badge> : <Badge tone="red">miss</Badge>}
                  </td>
                  <td className="py-2.5 pr-3">
                    <SessionValue value={s.value} unit={unit} />
                  </td>
                  <td className="py-2.5 text-right">
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-faint transition-colors duration-150 group-hover:text-foreground">
                      features
                      <ArrowUpRight className="size-3" aria-hidden="true" />
                    </span>
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

/** The envelope's own words and provenance: sticky under every results view. */
export function EnvelopeFooter({ result }: { result: QueryResult }) {
  return (
    <div className="sticky bottom-0 z-30 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-t-xl border border-border bg-background/85 px-4 py-2.5 backdrop-blur-md">
        <span className="font-mono text-[10.5px] text-muted-foreground">{result.disclaimer}</span>
        <span className="stat font-mono text-[10.5px] text-faint">
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
  // withholds every aggregate view too: counts and raw sessions only. A
  // "N too small" headline next to a 100% stability half would be a leak.
  const withheld = result.guards.refused && result.estimate === null;
  return (
    <div className="space-y-4">
      <Panel accent="prism" className="p-5">
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
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
              As the engine understood it
            </div>
            <code className="block max-w-full overflow-x-auto whitespace-nowrap rounded-lg border border-white/[0.08] bg-black/60 px-2.5 py-1.5 text-left font-mono text-xs">
              {result.query.dsl}
            </code>
            <div className="stat flex flex-wrap justify-end gap-1.5 font-mono text-[11px]">
              <Badge>{result.query.symbol}</Badge>
              <Badge>session {result.query.sessionKey}</Badge>
              {result.query.since ? <Badge>from {result.query.since}</Badge> : null}
              {result.query.until ? <Badge>to {result.query.until}</Badge> : null}
            </div>
          </div>
        </div>
        <div className="stat mt-3 font-mono text-xs text-muted-foreground">
          {fmtInt(result.successes)} hits across {fmtInt(result.n)} matched sessions
        </div>
        <div className="mt-3.5">
          <GuardBanner result={result} onForce={onForce} />
        </div>
      </Panel>

      {withheld ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          <StabilityBlock result={result} />
          <RecencyBlock result={result} />
          <PanelBlock
            label="per-year counts"
            footnote="Bar height is that year's hit rate; every bar carries its own N."
          >
            {result.perYear.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sessions matched, so there are no years to show.
              </p>
            ) : (
              <YearBars perYear={result.perYear} />
            )}
          </PanelBlock>
          {result.distribution ? (
            <PanelBlock
              label="value distribution"
              aside={
                <span className="stat font-mono text-[11px] text-faint">
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
