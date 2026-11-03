import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API = "http://127.0.0.1:24001";
export const ADMIN_USER = "e2eadmin";
export const ADMIN_PASSWORD = "correct-horse-battery-1";
export const CHANNEL_URL = "https://www.youtube.com/channel/UCfakechannel0000000000a";

let cachedCookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | null = null;

/** Sign in through the API once per worker; later calls reuse the session cookie (avoids the login throttle). */
export async function login(page: Page) {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    const me = await page.request.get("/api/auth/me");
    if (me.ok()) return;
  }
  const r = await page.request.post("/api/auth/login", {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    headers: { "X-NoCon-CSRF": "1" },
  });
  expect(r.ok(), `login -> ${r.status()}`).toBeTruthy();
  cachedCookies = await page.context().cookies();
}

/** Authenticated API calls from the browser context (shares the session cookie via the web proxy). */
export async function apiGet<T = any>(page: Page, p: string): Promise<T> {
  const r = await page.request.get(p);
  expect(r.ok(), `GET ${p} -> ${r.status()}`).toBeTruthy();
  return r.json();
}

export async function firstMediaId(page: Page, title = "Fake video 1"): Promise<string> {
  const j = await apiGet(page, `/api/library/media?q=${encodeURIComponent(title)}&availability=all`);
  const m = j.items.find((i: any) => i.title === title) ?? j.items[0];
  expect(m, `media ${title}`).toBeTruthy();
  return m.id;
}

export const H264_AAC = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
export const HLS_MIME = "application/vnd.apple.mpegurl";

/** What this browser build reports it can decode. Run on about:blank, so it needs no server. */
export async function probeCodecs(page: Page) {
  return page.evaluate(
    ([h264, hls]) => {
      const v = document.createElement("video");
      return {
        h264Aac: v.canPlayType(h264),
        vp9Opus: v.canPlayType('video/webm; codecs="vp9, opus"'),
        nativeHls: v.canPlayType(hls),
        mse: typeof (window as any).MediaSource !== "undefined" || typeof (window as any).ManagedMediaSource !== "undefined",
      };
    },
    [H264_AAC, HLS_MIME],
  );
}

/**
 * The e2e fixtures are H.264/AAC. Where the browser build cannot decode them (Playwright's Linux Firefox
 * and WebKit builds may not), skip with the measured reason rather than letting the test fail or pass falsely.
 */
export async function skipUnlessH264(page: Page, skip: (condition: boolean, reason: string) => void, browserName: string) {
  await page.goto("about:blank");
  const c = await probeCodecs(page);
  skip(!c.h264Aac, `${browserName} build cannot decode the H.264/AAC fixture (canPlayType(${H264_AAC}) = "${c.h264Aac}")`);
}

export type { APIRequestContext };
