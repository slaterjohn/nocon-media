import { defineConfig, devices } from "@playwright/test";

export const WEB_PORT = 24000;
export const API_PORT = 24001;

// Engine subset: 06 (playback), 11 (codec report and the HLS path) and 09 (accessibility, layout and focus handling) are the browser-dependent
// specs. 01-04 are included only because the database is rebuilt for every run and playback needs the
// setup wizard, login, a source and a downloaded video. The rest is server logic and stays Chromium-only.
const ENGINE_SPECS = [/0[1-46]-.*\.spec\.ts/, /09-a11y\.spec\.ts/, /11-engine-media\.spec\.ts/];

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    // Engine projects run only the specs that depend on the browser's media stack. Run one engine per
    // invocation (pnpm test:e2e:firefox / test:e2e:webkit): they share ports 24000/24001.
    {
      name: "firefox",
      testMatch: ENGINE_SPECS,
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0, "media.autoplay.block-webaudio": false },
        },
      },
    },
    {
      // WebKit has no autoplay flag; the specs start playback from a click, which counts as a user gesture.
      name: "webkit",
      testMatch: ENGINE_SPECS,
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
