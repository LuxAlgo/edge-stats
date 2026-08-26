/*
  Small UI primitives: panels, badges, inputs, error/empty states. All
  colors come from the theme tokens; all numbers set tabular digits.
*/
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { fmtInt } from "../lib/format";

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>{children}</section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-dim">{children}</div>
  );
}

export type Tone = "dim" | "accent" | "green" | "red" | "warn";

const toneClasses: Record<Tone, string> = {
  dim: "border-line bg-panel-2 text-dim",
  accent: "border-accent/40 bg-accent/10 text-accent",
  green: "border-pos/40 bg-pos/10 text-pos",
  red: "border-neg/40 bg-neg/10 text-neg",
  warn: "border-warn/40 bg-warn/10 text-warn",
};

export function Badge({
  tone = "dim",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

/** The sample size, always adjacent to its estimate. */
export function NBadge({ n }: { n: number }) {
  return (
    <Badge tone="dim" title={`${fmtInt(n)} matched sessions`}>
      <span className="stat">N {fmtInt(n)}</span>
    </Badge>
  );
}

export function LowSampleBadge() {
  return (
    <Badge tone="warn" title="Below the warn floor: read this number with suspicion">
      LOW SAMPLE
    </Badge>
  );
}

/** First-half vs second-half agreement: ✓ compatible, ✗ the halves disagree. */
export function StabilityTick({ agree }: { agree: boolean | null }) {
  if (agree === null) {
    return (
      <Badge tone="dim" title="Stability split unavailable (a half is empty)">
        stability —
      </Badge>
    );
  }
  return agree ? (
    <Badge tone="green" title="First and second half CIs overlap">
      ✓ stable
    </Badge>
  ) : (
    <Badge tone="red" title="First and second half CIs do not overlap">
      ✗ unstable
    </Badge>
  );
}

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-dim">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-2 text-sm text-ink " +
  "placeholder:text-dim/70 focus:border-accent";

export function SelectInput({
  value,
  onChange,
  children,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  ariaLabel,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "date";
  ariaLabel?: string;
  mono?: boolean;
}) {
  return (
    <input
      aria-label={ariaLabel}
      className={`${inputClass} ${mono ? "font-mono" : ""} stat`}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Button({
  onClick,
  children,
  variant = "ghost",
  disabled = false,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const styles =
    variant === "primary"
      ? "bg-accent text-white hover:brightness-110 border-transparent"
      : variant === "danger"
        ? "border-line text-neg hover:border-neg/60"
        : "border-line text-ink hover:border-accent/60";
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function CopyButton({ text, caption }: { text: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "copied" : "copy"}
      </Button>
      {caption ? <span className="text-xs text-dim">{caption}</span> : null}
    </span>
  );
}

/** Error panel: the message plus the engine's hint, when it sent one. */
export function ErrorNote({ error, compact = false }: { error: Error; compact?: boolean }) {
  const hint = error instanceof ApiError ? error.hint : null;
  return (
    <div
      role="alert"
      className={`rounded-lg border border-neg/40 bg-neg/10 ${compact ? "p-2 text-xs" : "p-3 text-sm"}`}
    >
      <div className="font-medium text-neg">{error.message}</div>
      {hint ? <div className="mt-1 text-dim">hint: {hint}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel/50 px-6 py-10 text-center">
      <div className="text-base font-medium">{title}</div>
      {children ? (
        <div className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-dim">{children}</div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-relaxed text-ink">
      {children}
    </pre>
  );
}
