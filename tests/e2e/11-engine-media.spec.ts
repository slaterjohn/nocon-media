import { test, expect } from "@playwright/test";
import { firstMediaId, login, probeCodecs, skipUnlessH264 } from "./helpers";

// Engine-dependent media checks. Runs in every project; the annotations record what each engine reported.

test("codec and streaming support reported by this browser", async ({ page, browserName }, info) => {
  await page.goto("about:blank");
  const c = await probeCodecs(page);
  info.annotations.push({ type: "codecs", description: `${browserName}: ${JSON.stringify(c)}` });
  console.log(`[engine] ${browserName} ${JSON.stringify(c)}`);
  // Every engine we support must be able to stream HLS one way or the other: natively (Safari) or via MSE (hls.js).
  expect(c.nativeHls !== "" || c.mse, "neither native HLS nor Media Source Extensions is available").toBeTruthy();
});

test.describe.serial("HLS playback path", () => {
  test("a video that is not direct-play is prepared as HLS and plays", async ({ page, browserName }, info) => {
    test.setTimeout(120_000);
    await skipUnlessH264(page, test.skip, browserName);
    const c = await probeCodecs(page);
    await login(page);
    const id = await firstMediaId(page, "Fake video 2");

    // The fixtures are mp4, so the API reports directPlay: true. Report false for this page only, which is
    // what it does for an mkv or other non-direct-play file. The manifest request then makes the real server
    // queue a real ffmpeg remux, and the engine plays what comes back.
    await page.route(`**/api/media/${id}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      if (body?.media) body.media.directPlay = false;
      await route.fulfill({ response: res, json: body });
    });

    const manifest = page.waitForResponse((r) => r.url().includes(`/api/media/${id}/hls/index.m3u8`) && r.status() === 200, { timeout: 90_000 });
    await page.goto(`/watch/${id}`);
    await manifest;

    const video = page.locator("video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const src = await video.evaluate((v: HTMLVideoElement) => v.currentSrc || v.src);
    // Native HLS keeps the manifest URL as the source; hls.js attaches a blob: MediaSource URL.
    const path = src.startsWith("blob:") ? "hls.js (Media Source Extensions)" : "native HLS";
    if (src.startsWith("blob:")) expect(c.mse).toBeTruthy();
    else expect(src).toContain(`/api/media/${id}/hls/index.m3u8`);
    info.annotations.push({ type: "hls-path", description: `${browserName}: ${path}` });
    console.log(`[engine] ${browserName} HLS played through ${path}`);

    await page.getByRole("button", { name: "Mute" }).click();
    await page.getByRole("button", { name: "Play" }).last().click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3);
    expect(await video.evaluate((v: HTMLVideoElement) => v.error?.code ?? null)).toBeNull();
  });
});
