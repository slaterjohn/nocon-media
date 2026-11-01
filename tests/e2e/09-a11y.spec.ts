import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { firstMediaId, login } from "./helpers";

const PAGES = [
  "/", "/library", "/channels", "/playlists", "/collections", "/recent", "/continue", "/favourites", "/search",
  "/admin", "/admin/sources", "/admin/downloads", "/admin/media", "/admin/discovery", "/admin/storage",
  "/admin/clients", "/admin/activity", "/admin/settings", "/admin/settings/general", "/admin/settings/storage",
  "/admin/settings/players", "/admin/settings/discovery", "/admin/settings/account", "/admin/system",
];

test.describe("accessibility smoke", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const path of [...PAGES, "watch"]) {
    test(`landmarks, skip link and axe on ${path}`, async ({ page }) => {
      const url = path === "watch" ? `/watch/${await firstMediaId(page, "Fake long video 4")}` : path;
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main, [role=main]")).toHaveCount(1);

      // Skip link is the first tab stop and moves focus into main.
      // Reset the focus navigation starting point to the top of the document (some pages autofocus a field).
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.collapse(document.body, 0);
      });
      const skip = page.getByRole("link", { name: "Skip to main content" });
      // After a blur Chrome may spend the first Tab on <body>, so allow one extra press.
      for (let i = 0; i < 2 && !(await skip.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => { const a = document.activeElement; return !!a && (a.id === "main" || !!a.closest("main")); }))
        .toBe(true);

      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      test.info().annotations.push({ type: "axe", description: `${path}: ${results.violations.length} violations, ${bad.length} serious/critical` });
      console.log(`AXE ${path}: total=${results.violations.length} serious/critical=${bad.length}`);
      expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  test("login page: one h1, one main, axe clean", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    console.log(`AXE /login: total=${results.violations.length} serious/critical=${bad.length}`);
    expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    await ctx.close();
  });

  test("Tab reaches the primary action with a visible focus indicator", async ({ page }) => {
    await page.goto("/admin/sources");
    await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const add = page.getByRole("button", { name: "Add source" }).first();
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await add.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Add source is reachable by Tab").toBe(true);
    const style = await add.evaluate((el) => {
      const c = getComputedStyle(el);
      return { outlineStyle: c.outlineStyle, outlineWidth: parseFloat(c.outlineWidth), boxShadow: c.boxShadow };
    });
    const visible = (style.outlineStyle !== "none" && style.outlineWidth > 0) || (style.boxShadow && style.boxShadow !== "none");
    expect(visible, JSON.stringify(style)).toBe(true);
  });
});
