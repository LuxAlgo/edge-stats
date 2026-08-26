/*
  Data-fetching hooks. Every fetch is tied to an AbortController that the
  effect cleanup aborts — navigating away cancels in-flight work.
*/
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "wouter";

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Run an abortable async producer; re-runs when `deps` change, aborts on unmount. */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fnRef.current(ctrl.signal).then(
      (value) => {
        if (ctrl.signal.aborted) return;
        setData(value);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted || isAbort(e)) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/*
  Session-lifetime cache for the small static resources (registry, symbols,
  presets) so page changes render instantly instead of re-skeletoning.
*/
const staticCache = new Map<string, unknown>();

export function useCachedAsync<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
): AsyncState<T> {
  const state = useAsync<T>(
    async (signal) => {
      const hit = staticCache.get(key);
      if (hit !== undefined) return hit as T;
      const value = await fn(signal);
      staticCache.set(key, value);
      return value;
    },
    [key],
  );
  const cached = staticCache.get(key);
  if (cached !== undefined && state.data === null && state.error === null) {
    return { ...state, data: cached as T, loading: false };
  }
  return state;
}

/** Debounce a value; the query pages use this to auto-run without spamming the engine. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** URL query-string state: read params, patch several at once (null deletes). */
export function useUrlParams(): {
  params: URLSearchParams;
  patch: (updates: Record<string, string | null>, opts?: { replace?: boolean }) => void;
} {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (updates: Record<string, string | null>, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: opts?.replace ?? true },
      );
    },
    [setParams],
  );
  return { params, patch };
}

/*
  Concurrency limiter for the reports grid: preset cards run lazily through
  a shared pool of query slots so a large catalog never floods the engine.
*/
const MAX_CONCURRENT_QUERIES = 4;
let activeQueries = 0;
const waiters: Array<() => void> = [];

export async function withQuerySlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  while (activeQueries >= MAX_CONCURRENT_QUERIES) {
    await new Promise<void>((resolve) => waiters.push(resolve));
    if (signal.aborted) {
      waiters.shift()?.(); // pass the freed slot to the next card
      throw new DOMException("aborted while queued", "AbortError");
    }
  }
  activeQueries += 1;
  try {
    return await fn();
  } finally {
    activeQueries -= 1;
    waiters.shift()?.();
  }
}

/*
  '/' anywhere focuses the builder's DSL box. Pages other than the builder
  navigate first and leave a pending flag the builder consumes on mount.
*/
let pendingDslFocus = false;
export const DSL_FOCUS_EVENT = "edge-stats:focus-dsl";

export function requestDslFocus(): void {
  pendingDslFocus = true;
  window.dispatchEvent(new Event(DSL_FOCUS_EVENT));
}

export function consumePendingDslFocus(): boolean {
  const pending = pendingDslFocus;
  pendingDslFocus = false;
  return pending;
}
