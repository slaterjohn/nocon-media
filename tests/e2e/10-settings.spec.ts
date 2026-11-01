import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { apiGet, login } from "./helpers";

const PAGES = [
  { name: "General", path: "/admin/settings/general" },
  { name: "Storage", path: "/admin/settings/storage" },
  { name: "External player access", path: "/admin/settings/players" },
  { name: "Discovery", path: "/admin/settings/discovery" },
  { name: "Account and security", path: "/admin/settings/account" },
];

const advancedButton = (page: Page) => page.getByRole("button", { name: /^Advanced settings/ });

test.describe.serial("settings hub and pages", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("hub lists each settings page and every link loads a page with a breadcrumb", async ({ page }) => {
    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(1);
    const main = page.locator("main");
    for (const p of PAGES) await expect(main.getByRole("link", { name: p.name, exact: true })).toHaveAttribute("href", p.path);
    // Cards carry a summary of the current value.
    await expect(main.getByText(/^(Lightweight|Standard) profile, \d+p$/)).toBeVisible();

    for (const p of PAGES) {
      await page.goto("/admin/settings");
      await main.getByRole("link", { name: p.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${p.path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: p.name })).toBeVisible();
      const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(crumb.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/admin/settings");
      await expect(crumb.locator("[aria-current=page]")).toHaveText(p.name);
      await expect(main.getByRole("link", { name: /Back to Settings/ })).toBeVisible();
      // The sidebar keeps Settings as the active entry.
      await expect(page.getByRole("navigation", { name: "Manage" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    }
  });

  test("Advanced settings is collapsed by default and works from the keyboard", async ({ page }) => {
    for (const path of ["/admin/settings/storage", "/admin/settings/players", "/admin/settings/discovery"]) {
      await page.goto(path);
      const btn = advancedButton(page);
      await expect(btn).toHaveAttribute("aria-expanded", "false");
      const panelId = await btn.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = page.locator(`[id="${panelId}"]`);
      await expect(panel).toBeHidden();

      await btn.focus();
      await page.keyboard.press("Enter");
      await expect(btn).toHaveAttribute("aria-expanded", "true");
      await expect(panel).toBeVisible();
      await page.keyboard.press("Space");
      await expect(btn).toHaveAttribute("aria-expanded", "false");
      await expect(panel).toBeHidden();
      await page.keyboard.press("Enter");
      await expect(btn).toHaveAttribute("aria-expanded", "true");

      // Reloading starts closed again: nothing is remembered.
      await page.reload();
      await expect(advancedButton(page)).toHaveAttribute("aria-expanded", "false");
    }
  });

  test("a validation error inside Advanced opens it and focuses the field", async ({ page }) => {
    await page.goto("/admin/settings/discovery");
    await expect(advancedButton(page)).toHaveAttribute("aria-expanded", "false");
    await page.getByLabel("Storage limit (GB)").fill("5");
    await advancedButton(page).click();
    await page.getByLabel("Minimum score").fill("7");
    await advancedButton(page).click();
    await expect(advancedButton(page)).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(advancedButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByLabel("Minimum score")).toBeFocused();
    await expect(page.getByText("Enter a number from 0 to 1.")).toBeVisible();
    // Nothing was saved.
    expect((await apiGet(page, "/api/settings")).discovery.minScore).not.toBe(7);
  });

  test("the collapsed header counts advanced values that differ from the defaults", async ({ page }) => {
    await page.goto("/admin/settings/storage");
    const before = (await apiGet(page, "/api/settings")).redownloadCooldownDays;
    await advancedButton(page).click();
    await page.getByLabel("Re-download cooldown (days)").fill(String(before === 12 ? 13 : 12));
    await advancedButton(page).click();
    await expect(advancedButton(page)).toContainText("1 changed");
    await page.goto("/admin/settings/storage");
  });

  test("saving on one page persists after a reload and leaves other settings alone", async ({ page }) => {
    const before = await apiGet(page, "/api/settings");
    await page.goto("/admin/settings/storage");
    await page.getByLabel("Soft limit (% used)").fill("81");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Storage settings saved").first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Soft limit (% used)")).toHaveValue("81");
    const after = await apiGet(page, "/api/settings");
    expect(after.softThreshold).toBe(81);
    expect(after.profile).toBe(before.profile);
    expect(after.enableXtream).toBe(before.enableXtream);

    // An advanced value on another page.
    await page.goto("/admin/settings/players");
    await advancedButton(page).click();
    await page.getByLabel("Networks allowed for Xtream and M3U").fill("192.168.0.0/16");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("External player settings saved").first()).toBeVisible();
    await page.reload();
    await advancedButton(page).click();
    await expect(page.getByLabel("Networks allowed for Xtream and M3U")).toHaveValue("192.168.0.0/16");
    expect((await apiGet(page, "/api/settings")).softThreshold).toBe(81);

    // Restore.
    await page.getByLabel("Networks allowed for Xtream and M3U").fill(before.xtreamAllowedCidrs.join("\n"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("External player settings saved").first()).toBeVisible();
    await page.goto("/admin/settings/storage");
    await page.getByLabel("Soft limit (% used)").fill(String(before.softThreshold));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Storage settings saved").first()).toBeVisible();
  });

  test("the source form keeps filters under Advanced settings", async ({ page }) => {
    await page.goto("/admin/sources");
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a source" });
    await expect(dialog.getByLabel("Resolution")).toBeVisible();
    await expect(dialog.getByLabel("Required keywords")).toBeHidden();
    const btn = dialog.getByRole("button", { name: /^Advanced settings/ });
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByLabel("Required keywords")).toBeVisible();
    // An invalid cron expression inside Advanced reopens it after a collapse.
    await dialog.getByLabel("Address or handle").fill("https://www.youtube.com/channel/UCfakechannel0000000000b");
    await dialog.getByLabel("How often to check for new videos").selectOption("cron");
    await dialog.getByLabel("Cron expression").fill("bad");
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await dialog.getByRole("button", { name: "Add source" }).click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByLabel("Cron expression")).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("axe finds no serious problems on the settings pages with Advanced open", async ({ page }) => {
    for (const path of ["/admin/settings", ...PAGES.map((p) => p.path)]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const btn = advancedButton(page);
      if (await btn.count()) await btn.click();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${path} ${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    }
  });
});
