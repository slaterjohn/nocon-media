"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "@/lib/api";
import type { Collection, MediaSummary } from "@/lib/types";

/** Why an item can't be played right now, or null when it can. Always text, never colour alone. */
export function unavailableLabel(m: Pick<MediaSummary, "availability" | "playable" | "temporarilyUnavailable">): string | null {
  if (m.playable) return null;
  if (m.temporarilyUnavailable) return "Drive disconnected";
  switch (m.availability) {
    case "evicted":
      return "Removed to free space";
    case "downloading":
      return "Downloading";
    case "queued":
      return "Queued";
    case "failed":
      return "Download failed";
    case "available":
      return "Drive disconnected";
    default:
      return "Not downloaded";
  }
}

export function collectionCount(c: Collection): number {
  return c.count ?? c.itemCount ?? c.mediaCount ?? c.items?.length ?? 0;
}

/** Paged list with a "Load more" button. `path` carries every filter except limit and offset. */
export function useLoadMore<T extends { id: string }>(path: string, pageSize = 24) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const seq = useRef(0);
  const itemsRef = useRef<T[]>([]);

  const fetchPage = useCallback(
    async (offset: number, reset: boolean) => {
      const id = ++seq.current;
      const sep = path.includes("?") ? "&" : "?";
      try {
        const res = await api<{ items: T[]; total?: number }>(`${path}${sep}limit=${pageSize}&offset=${offset}`);
        if (id !== seq.current) return;
        const base = reset ? [] : itemsRef.current;
        const seen = new Set(base.map((x) => x.id));
        const fresh = res.items.filter((x) => !seen.has(x.id));
        const next = [...base, ...fresh];
        itemsRef.current = next;
        setItems(next);
        setTotal(res.total);
        setMore(fresh.length > 0 && (res.total !== undefined ? next.length < res.total : res.items.length >= pageSize));
        setError(undefined);
      } catch (e) {
        if (id !== seq.current) return;
        setError(e as ApiError);
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [path, pageSize],
  );

  useEffect(() => {
    itemsRef.current = [];
    setItems([]);
    setTotal(undefined);
    setMore(true);
    setLoading(true);
    void fetchPage(0, true);
    return () => {
      seq.current++;
    };
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    void fetchPage(itemsRef.current.length, false);
  }, [fetchPage]);
  const reload = useCallback(() => {
    setLoading(true);
    void fetchPage(0, true);
  }, [fetchPage]);

  return { items, total, hasMore: more, loading, loadingMore, error, loadMore, reload };
}

const AUTOPLAY_KEY = "nocon.autoplayNext";

/** Autoplay-next preference, kept in localStorage. Defaults to on. */
export function useAutoplayPref(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(AUTOPLAY_KEY);
      if (v !== null) setValue(v === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const set = useCallback((v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(AUTOPLAY_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [value, set];
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
