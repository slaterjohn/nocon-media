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

export type { APIRequestContext };
