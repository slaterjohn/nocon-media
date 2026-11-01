"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_PAGES = ["/login", "/setup"];

function redirectTo(path: string) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.location.assign(path);
}

function onPublicPage() {
  if (typeof window === "undefined") return false;
  return PUBLIC_PAGES.some((p) => window.location.pathname.startsWith(p));
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** FormData is sent as multipart; anything else is JSON. */
  signal?: AbortSignal;
  /** Skip the 401/409 redirects (used by login and setup calls). */
  noRedirect?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (MUTATING.has(method)) headers["X-NoCon-CSRF"] = "1";

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "include", signal: opts.signal, cache: "no-store" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach the server. Check your connection, then try again.");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    const code = e.error ?? (res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : "error");
    const message = e.message ?? defaultMessage(res.status);
    if (!opts.noRedirect) {
      if (res.status === 401 && !onPublicPage()) redirectTo("/login");
      if (res.status === 409 && code === "setup_required" && !window.location.pathname.startsWith("/setup")) {
        redirectTo("/setup");
      }
    }
    throw new ApiError(res.status, code, message, e.details);
  }
  return data as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Your session has ended. Sign in again.";
  if (status === 403) return "That action isn't allowed.";
  if (status === 404) return "That item no longer exists.";
  if (status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (status >= 500) return "The server hit a problem. Try again, and check the system health page if it persists.";
  return "The request failed. Check the details and try again.";
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

/** Turns zod issues in `details` into a map keyed by field path. */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return out;
  for (const issue of err.details as { path?: (string | number)[]; message?: string }[]) {
    const key = (issue.path ?? []).join(".");
    if (key && issue.message && !out[key]) out[key] = issue.message;
  }
  return out;
}

export interface UseApiOptions {
  refreshInterval?: number;
  /** Set false to hold off fetching. */
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  isLoading: boolean;
  isValidating: boolean;
  mutate: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

/** Minimal SWR-style hook: keeps stale data while revalidating, polls, and refetches on focus. */
export function useApi<T>(path: string | null, opts: UseApiOptions = {}): UseApiResult<T> {
  const { refreshInterval, enabled = true } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [isValidating, setValidating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const pathRef = useRef(path);

  useEffect(() => {
    if (pathRef.current !== path) {
      pathRef.current = path;
      setData(undefined);
      setError(undefined);
      setLoaded(false);
    }
  }, [path]);

  const load = useCallback(async () => {
    if (!path || !enabled) return;
    const id = ++seq.current;
    setValidating(true);
    try {
      const res = await api<T>(path);
      if (id !== seq.current) return;
      setData(res);
      setError(undefined);
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof DOMException) return;
      setError(e as ApiError);
    } finally {
      if (id === seq.current) {
        setValidating(false);
        setLoaded(true);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  useEffect(() => {
    if (!refreshInterval || !enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, refreshInterval);
    return () => clearInterval(t);
  }, [refreshInterval, enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, load]);

  return {
    data,
    error,
    isLoading: enabled && !!path && !loaded && !error,
    isValidating,
    mutate: load,
    setData,
  };
}
