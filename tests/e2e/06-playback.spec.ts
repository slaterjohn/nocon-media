import { test, expect, type Page } from "@playwright/test";
import { apiGet, firstMediaId, login } from "./helpers";

// The e2e catalogue adds a 30 s video ("Fake long video 4") so seeking and resuming have room.
const time = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);

test.describe.serial("playback", () => {
  let id = "";

  test.beforeEach(async ({ page }) => {
    await login(page);
    if (!id) id = await firstMediaId(page, "Fake long video 4");
  });

  test("video gets a source and plays, seeks, pauses", async ({ page }) => {
    await page.goto(`/watch/${id}`);
    const video = page.locator("video");
    await expect(page.getByRole("heading", { level: 1, name: "Fake long video 4" })).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentSrc || v.src)).toContain(`/api/media/${id}/stream`);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "Mute" }).click();
    await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();

    await page.getByRole("button", { name: "Play" }).last().click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => time(page), { timeout: 8000 }).toBeGreaterThan(0.3);

    // Pause, then seek with the slider.
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Play" }).last()).toBeVisible();
    const seek = page.getByRole("slider", { name: "Seek" });
    await seek.fill("20");
    await expect.poll(() => time(page)).toBeGreaterThan(19.5);

    // Keyboard seek: ArrowLeft jumps back 5 s when focus is on the player (not the slider).
    await page.getByRole("region", { name: /Video player/ }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => time(page)).toBeLessThan(15.5);
    await expect.poll(() => time(page)).toBeGreaterThan(14.5);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => time(page)).toBeGreaterThan(19.5);
  });

  test("progress is saved and resumes after reload", async ({ page }) => {
    await page.goto(`/watch/${id}`);
    await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Mute" }).click();
    await page.getByRole("button", { name: "Play" }).last().click();
    await expect.poll(() => time(page)).toBeGreaterThan(0.3);
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByRole("slider", { name: "Seek" }).fill("12");
    // Leaving the page (client-side navigation) unmounts the player, which saves progress.
    await page.getByRole("link", { name: "Library", exact: true }).first().click();
    await expect(page).toHaveURL(/\/library/);
    await expect
      .poll(async () => (await apiGet(page, `/api/media/${id}`)).media.progress?.positionSeconds ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    await page.goto(`/watch/${id}`);
    await expect(page.getByText(/Resuming from/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Resuming from/)).toBeVisible();
  });

  test("captions control exposes the English subtitle", async ({ page }) => {
    // Subtitles are off by default: enable them on the source, then evict and re-download this video.
    await page.goto("/admin/sources");
    const row = page.getByRole("row").filter({ hasText: /UCfakechannel0000000000a|Fake Channel/ });
    await row.getByRole("button", { name: /^Edit/ }).click();
    const dialog = page.getByRole("dialog", { name: /Edit/ });
    await dialog.getByRole("switch", { name: "Download subtitles" }).check();
    // Subtitle languages sit under Advanced settings.
    await dialog.getByRole("button", { name: /^Advanced settings/ }).click();
    await dialog.getByLabel("Subtitle languages").fill("en");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    const ev = await page.request.delete(`/api/media/${id}`, { headers: { "X-NoCon-CSRF": "1" } });
    expect(ev.ok(), `evict -> ${ev.status()}`).toBeTruthy();
    const r = await page.request.post(`/api/media/${id}/download`, { headers: { "X-NoCon-CSRF": "1" } });
    expect(r.ok(), `re-download -> ${r.status()}`).toBeTruthy();
    await expect
      .poll(async () => (await apiGet(page, `/api/media/${id}`)).media.subtitles.map((s: any) => s.language), { timeout: 45_000, intervals: [1000] })
      .toContain("en");

    await page.goto(`/watch/${id}`);
    await expect(page.locator("video track[kind=subtitles][srclang=en]")).toHaveCount(1);
    // One subtitle track: the control is a toggle button (several tracks would give a menu).
    const caps = page.getByRole("button", { name: "Captions", exact: true });
    await expect(caps).toBeVisible();
    await caps.click();
    await expect(caps).toHaveAttribute("aria-pressed", "true");
    const sub = await page.request.get((await apiGet(page, `/api/media/${id}`)).media.subtitles[0].url);
    expect(await sub.text()).toContain("WEBVTT");
  });

  test("? opens the keyboard shortcuts dialog", async ({ page }) => {
    await page.goto(`/watch/${id}`);
    await page.getByRole("region", { name: /Video player/ }).focus();
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
