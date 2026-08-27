/*
  UI primitives in the house design system: quiet #0a0a0a panels with
  white-alpha hairlines, pill buttons and chips, mono for data and labels,
  status color never without a text label. Variants are cva-composed and
  every class list runs through cn(), shadcn-style.
*/
import { useState } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { Check, ChevronDown, CircleAlert, Copy, X } from "lucide-react";
import { ApiError } from "../lib/api";
import { fmtInt } from "../lib/format";
import { cn } from "../lib/utils";

/*
  The prism hairline: the landing page's flagship-panel accent, a 1px
  multi-hue light along the top edge. At most one per view.
*/
const PRISM_HAIRLINE =
  "bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--sky-400)_40%,transparent)_28%,color-mix(in_srgb,var(--purple-500)_40%,transparent)_55%,color-mix(in_srgb,var(--pink-500)_35%,transparent)_74%,transparent)]";

export function Panel({
  children,
  className = "",
  accent = "none",
}: {
  children: ReactNode;
  className?: string;
  accent?: "none" | "prism";
}) {
  return (
    <section
      className={cn("relative overflow-hidden rounded-xl border border-border bg-card", className)}
    >
      {accent === "prism" ? (
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-x-6 top-0 h-px", PRISM_HAIRLINE)}
        />
      ) : null}
      {children}
    </section>
  );
}

/** Quiet mono header row for a panel, in the landing exhibit style. */
export function PanelHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-white/[0.06] px-4 py-2">
      <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{children}</div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/** Mono-caps eyebrow: section markers and form-group labels, used sparingly. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">{children}</div>
  );
}

export type Tone = "dim" | "accent" | "green" | "red" | "warn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
  {
    variants: {
      tone: {
        dim: "border-border bg-white/[0.04] text-muted-foreground",
        accent: "border-chart-1/30 bg-chart-1/10 text-chart-1",
        green: "border-success/25 bg-success/10 text-success",
        red: "border-destructive/30 bg-destructive/10 text-destructive",
        warn: "border-warning/25 bg-warning/10 text-warning",
      },
    },
    defaultVariants: { tone: "dim" },
  },
);

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
    <span title={title} className={badgeVariants({ tone })}>
      {children}
    </span>
  );
}

/** The sample size, always adjacent to its estimate. */
export function NBadge({ n }: { n: number }) {
  return (
    <Badge tone="dim" title={`${fmtInt(n)} matched sessions`}>
      <span className="stat font-mono">N {fmtInt(n)}</span>
    </Badge>
  );
}

export function LowSampleBadge() {
  return (
    <Badge tone="warn" title="Below the warn floor: read this number with suspicion">
      <CircleAlert className="size-3" aria-hidden="true" />
      low sample
    </Badge>
  );
}

/** First-half vs second-half agreement: the icon and the word, never color alone. */
export function StabilityTick({ agree }: { agree: boolean | null }) {
  if (agree === null) {
    return (
      <Badge tone="dim" title="Stability split unavailable (a half is empty)">
        stability n/a
      </Badge>
    );
  }
  return agree ? (
    <Badge tone="green" title="First and second half CIs overlap">
      <Check className="size-3" aria-hidden="true" />
      stable
    </Badge>
  ) : (
    <Badge tone="red" title="First and second half CIs do not overlap">
      <X className="size-3" aria-hidden="true" />
      unstable
    </Badge>
  );
}

export function Labeled({
  label,
  children,
  code = false,
}: {
  label: string;
  children: ReactNode;
  /** Identifier labels (param names) keep their exact casing. */
  code?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span
        className={
          code
            ? "font-mono text-[11px] text-faint"
            : "font-mono text-[10px] uppercase tracking-[0.18em] text-faint"
        }
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Shared table header cell: quiet mono caps, used by every data table. */
export const tableHeadClass =
  "pb-2 pr-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint";

export const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-border bg-white/[0.03] px-2.5 text-[13px] text-foreground " +
  "placeholder:text-faint transition-colors duration-150 hover:border-white/20 focus:border-white/30 focus:outline-none";

const selectClass = cn(inputClass, "appearance-none pr-7");

/**
 * Styled native select: full keyboard and screen-reader behavior for free,
 * chrome from the design system. Low-level API mirrors <select>.
 */
export function NativeSelect({
  className,
  wrapperClassName,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <span className={cn("relative inline-flex min-w-0", wrapperClassName)}>
      <select className={cn(selectClass, className)} {...props} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-faint"
      />
    </span>
  );
}

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
    <NativeSelect
      aria-label={ariaLabel}
      wrapperClassName="w-full"
      className="w-full"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </NativeSelect>
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
      className={cn(inputClass, "stat", (mono || type !== "text") && "font-mono text-xs")}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const buttonVariants = cva(
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium " +
    "transition duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-white",
        ghost:
          "border border-border bg-white/[0.02] text-muted-foreground hover:border-white/25 hover:text-foreground",
        danger: "border border-border text-destructive hover:border-destructive/40",
      },
    },
    defaultVariants: { variant: "ghost" },
  },
);

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
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={buttonVariants({ variant })}
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
        {copied ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {copied ? "copied" : "copy"}
      </Button>
      {caption ? <span className="text-xs text-faint">{caption}</span> : null}
    </span>
  );
}

/** Error panel: the message plus the engine's hint, when it sent one. */
export function ErrorNote({ error, compact = false }: { error: Error; compact?: boolean }) {
  const hint = error instanceof ApiError ? error.hint : null;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/10",
        compact ? "p-2.5 text-xs" : "p-3.5 text-sm",
      )}
    >
      <div className="flex items-start gap-2 font-medium text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{error.message}</span>
      </div>
      {hint ? <div className="mt-1.5 pl-5.5 text-muted-foreground">hint: {hint}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/60 px-6 py-12 text-center">
      <div className="text-base font-medium tracking-tight">{title}</div>
      {children ? (
        <div className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-white/[0.05]", className)} aria-hidden="true" />
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-white/[0.08] bg-black/60 p-3 font-mono text-xs leading-relaxed text-foreground">
      {children}
    </pre>
  );
}
