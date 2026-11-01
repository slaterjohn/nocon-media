import type { Redis } from "ioredis";
import { logActivity, raiseNotification, resolveNotification, type Database } from "@nocon/database";
import type { Logger } from "@nocon/shared";

export const CONNECTIVITY_KEY = "nocon:connectivity";
const NOTIFICATION_KEY = "connectivity:offline";

export interface Probe { url: string; ok: boolean; ms: number; error?: string }

/** Any HTTP response counts as reachable. HEAD first, GET as fallback (some hosts reject HEAD). */
export async function probeUrl(fetchFn: typeof fetch, url: string, timeoutMs = 5000): Promise<Probe> {
  const started = Date.now();
  let lastError = "";
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetchFn(url, { method, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      await res.body?.cancel().catch(() => undefined);
      return { url, ok: true, ms: Date.now() - started };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { url, ok: false, ms: Date.now() - started, error: lastError };
}

export class ConnectivityMonitor {
  private state: boolean | null = null;

  constructor(
    private readonly deps: { db: Database; redis: Redis; log: Logger; urls: string[]; fetch: typeof fetch },
  ) {}

  /** Optimistic until the first probe finishes. */
  get online(): boolean {
    return this.state ?? true;
  }

  /** Probes all URLs. Returns whether the state flipped to online (so the caller can catch up work). */
  async check(): Promise<{ online: boolean; restored: boolean }> {
    const { db, redis, log } = this.deps;
    const probes = await Promise.all(this.deps.urls.map((u) => probeUrl(this.deps.fetch, u)));
    const online = probes.some((p) => p.ok);
    await redis.set(CONNECTIVITY_KEY, JSON.stringify({ online, checkedAt: new Date().toISOString(), probes }));

    const prev = this.state;
    this.state = online;
    let restored = false;
    if (prev !== online) {
      if (!online) {
        log.warn("connectivity lost");
        await logActivity(db, { type: "connectivity.lost", severity: "warning", message: "Internet connection lost, external jobs are paused" });
        await raiseNotification(db, {
          key: NOTIFICATION_KEY, severity: "warning", title: "No internet connection",
          body: "Downloads, source syncs and discovery wait until the connection returns. Local playback is unaffected.",
        });
      } else if (prev === false) {
        restored = true;
        log.info("connectivity restored");
        await logActivity(db, { type: "connectivity.restored", message: "Internet connection restored" });
        await resolveNotification(db, NOTIFICATION_KEY);
      }
    }
    return { online, restored };
  }
}
