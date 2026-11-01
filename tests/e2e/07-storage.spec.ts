import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test.describe.serial("storage", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/admin/storage");
    await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
  });

  test("volume is online and thresholds are visible", async ({ page }) => {
    await expect(page.getByText("E2E volume").first()).toBeVisible();
    await expect(page.getByText("Online", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("progressbar", { name: "E2E volume capacity" }).first()).toBeVisible();
    await expect(page.getByText(/Soft limit 80%/)).toBeVisible();
    await expect(page.getByText(/Minimum free 5%/)).toBeVisible();
  });

  test("simulation tool returns a result", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Size (GB)").fill("1");
    await page.getByLabel("Priority", { exact: true }).selectOption("P1");
    await page.getByRole("button", { name: "Run simulation" }).click();
    await expect(page.getByText("Required", { exact: true })).toBeVisible();
    await expect(page.getByText("Would be reclaimed")).toBeVisible();
    await expect(page.getByText(/There is enough space|Not enough can be reclaimed/)).toBeVisible();
  });

  test("eviction history renders", async ({ page }) => {
    // The playback tests evicted and re-downloaded one video, so there is at least one record.
    const table = page.getByRole("table", { name: "Eviction history" });
    const empty = page.getByText("Nothing has been evicted");
    await expect(table.or(empty)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Eviction history" })).toBeVisible();
  });
});
