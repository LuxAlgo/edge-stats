/*
  The app shell: wordmark, primary nav, engine health chip, and the global
  '/' shortcut that jumps to the query builder's DSL box from anywhere.
*/
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { requestDslFocus, useCachedAsync } from "../lib/hooks";
import { cn } from "../lib/utils";

/** Original mark: three ascending bars, the last one carrying its interval whisker. */
function Mark() {
  return (
    <svg viewBox="0 0 22 22" className="h-[18px] w-[18px]" aria-hidden="true">
      <rect x="2" y="13" width="4" height="7" rx="1" fill="var(--faint)" />
      <rect x="9" y="9" width="4" height="11" rx="1" fill="var(--muted-foreground)" />
      <rect x="16" y="5" width="4" height="15" rx="1" fill="var(--chart-1)" />
      <rect x="17.5" y="2" width="1" height="6" fill="var(--foreground)" />
      <rect x="16" y="2" width="4" height="1" fill="var(--foreground)" />
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
  if (health.loading) return <span className="font-mono text-[11px] text-faint">connecting…</span>;
  if (health.error || !health.data?.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-destructive">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" /> engine unreachable
      </span>
    );
  }
  return (
    <span
      className="stat inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.02] px-2.5 py-1 font-mono text-[11px] leading-none text-faint"
      title="Local engine is up: this store fingerprint is stamped on every result"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      {health.data.fingerprint}
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
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-7 px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[15px] font-medium tracking-tight">Edge Stats</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV.map((item) => {
              const active = item.match(location);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors duration-150",
                    active
                      ? "bg-white/[0.06] text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <span className="hidden items-center gap-1.5 font-mono text-[11px] text-faint sm:inline-flex">
              <kbd className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
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
