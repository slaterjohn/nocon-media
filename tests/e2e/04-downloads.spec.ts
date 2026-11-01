import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test.describe.serial("downloads", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("items progress to completed within 60 s", async ({ page }) => {
    await page.goto("/admin/downloads");
    await expect(page.getByRole("heading", { level: 1, name: "Downloads" })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Download state" });
    await expect(tabs).toBeVisible();

    await expect
      .poll(
        async () => {
          const j = await (await page.request.get("/api/downloads?state=ready,completed&limit=100")).json();
          return j.items.length;
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBeGreaterThanOrEqual(3);

    await tabs.getByRole("tab", { name: /^Completed/ }).click();
    const table = page.getByRole("table", { name: "Completed downloads" });
    await expect(table).toBeVisible();
    for (const n of [1, 2, 3]) await expect(table.getByRole("row", { name: new RegExp(`Fake video ${n}`) })).toBeVisible();
    await expect(table.getByRole("progressbar", { name: /Progress for Fake video 1/ })).toBeVisible();
  });

  test("download a single video by URL", async ({ page }) => {
    await page.goto("/admin/downloads");
    await page.getByLabel("Download a video").fill("https://www.youtube.com/watch?v=fakevid0003");
    await page.getByRole("button", { name: "Download" }).click();
    await expect(page.getByText("Download queued").first()).toBeVisible();
    await expect(page.locator("#dl-url-error")).toHaveCount(0);
    await expect(page.getByLabel("Download a video")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Download" })).toBeEnabled();
  });
});
