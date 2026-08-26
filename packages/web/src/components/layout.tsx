/*
  The app shell: wordmark, primary nav, engine health chip, and the global
  '/' shortcut that jumps to the query builder's DSL box from anywhere.
*/
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { requestDslFocus, useCachedAsync } from "../lib/hooks";

/** Original mark: three ascending bars, the last one carrying its interval whisker. */
function Mark() {
  return (
    <svg viewBox="0 0 22 22" className="h-5 w-5" aria-hidden="true">
      <rect x="2" y="13" width="4" height="7" rx="1" fill="var(--text-dim)" />
      <rect x="9" y="9" width="4" height="11" rx="1" fill="var(--accent-2)" />
      <rect x="16" y="5" width="4" height="15" rx="1" fill="var(--accent)" />
      <rect x="17.5" y="2" width="1" height="6" fill="var(--text)" />
      <rect x="16" y="2" width="4" height="1" fill="var(--text)" />
    </svg>
  );
}

const NAV = [
  { href: "/", label: "Reports", match: (p: string) => p === "/" || p.startsWith("/report/") },
  { href: "/builder", label: "Builder", match: (p: string) => p.startsWith("/builder") },
  { href: "/live", label: "Live", match: (p: string) => p.startsWith("/live") },
  { href: "/data", label: "Data", match: (p: string) => p.startsWith("/data") },
];

function HealthChip() {
  const health = useCachedAsync("health", (signal) => api.health(signal));
  if (health.loading) return <span className="text-xs text-dim">connecting…</span>;
  if (health.error || !health.data?.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-neg">
        <span className="h-1.5 w-1.5 rounded-full bg-neg" /> engine unreachable
      </span>
    );
  }
  return (
    <span
      className="stat inline-flex items-center gap-1.5 font-mono text-[11px] text-dim"
      title="Local engine is up: this store fingerprint is stamped on every result"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-pos" />
      store {health.data.fingerprint}
    </span>
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      if (!location.startsWith("/builder")) navigate("/builder");
      requestDslFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [location, navigate]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[15px] font-semibold tracking-tight">Edge Stats</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = item.match(location);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    active ? "bg-panel-2 text-ink" : "text-dim hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <span className="hidden items-center gap-1.5 text-xs text-dim sm:inline-flex">
              <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[10px]">
                /
              </kbd>
              query
            </span>
            <HealthChip />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 pb-16 pt-8">{children}</main>
    </div>
  );
}
