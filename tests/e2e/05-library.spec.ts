import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test.describe.serial("library", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("home shows recently downloaded", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    const row = page.getByRole("region", { name: "Recently downloaded" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: /Fake video/ }).first()).toBeVisible();
  });

  test("library grid lists the fake videos", async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
    for (const n of [1, 2, 3]) await expect(page.getByRole("link", { name: `Fake video ${n}` })).toBeVisible();
  });

  test("search finds a fake video by title", async ({ page }) => {
    await page.goto("/search");
    // The header also has a search box with the same name; use the one in <main>.
    const box = page.getByRole("main").getByRole("searchbox", { name: "Search query" });
    await page.waitForLoadState("networkidle"); // a fill before hydration would be lost
    await box.fill("fake");
    const results = page.getByRole("list", { name: "Video results" });
    await expect(results.getByRole("link", { name: /Fake video/ }).first()).toBeVisible();
    await expect(results.getByRole("link", { name: "Fake video 2" })).toBeVisible();
  });

  test("channel page loads with media", async ({ page }) => {
    await page.goto("/channels");
    await page.getByRole("link", { name: /Fake Channel/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Fake Channel" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Videos from Fake Channel" }).getByRole("link", { name: /Fake video/ }).first()).toBeVisible();
  });
});
