import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "./helpers";

test("setup wizard runs end to end and lands on the dashboard", async ({ page }) => {
  await page.goto("/setup");

  // 1 Administrator
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Confirm password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // 2 System checks
  await expect(page.getByRole("heading", { level: 1, name: "System checks" })).toBeVisible();
  await expect(page.getByText("Database: working")).toBeVisible();
  await expect(page.getByText("Redis: working")).toBeVisible();
  await expect(page.getByText(/Worker: (working|not running)/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // 3 Storage
  await expect(page.getByRole("heading", { level: 1, name: "Storage location" })).toBeVisible();
  await page.getByLabel("Folder path").fill(process.env.E2E_MEDIA_DIR!);
  await page.getByLabel("Volume name").fill("E2E volume");
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Writable")).toBeVisible();
  const ack = page.getByLabel("I'm happy to store media on this filesystem.");
  if (await ack.isVisible().catch(() => false)) await ack.check();
  await page.getByRole("button", { name: "Confirm storage" }).click();

  // 4 Profile
  await expect(page.getByRole("heading", { level: 1, name: "Deployment profile" })).toBeVisible();
  await page.getByRole("radio", { name: /Lightweight/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // 5 Quality
  await expect(page.getByRole("heading", { level: 1, name: "Default quality" })).toBeVisible();
  await page.getByLabel("Default resolution").selectOption("720");
  await page.getByRole("button", { name: "Continue" }).click();

  // 6 Thresholds
  await expect(page.getByRole("heading", { level: 1, name: "Storage thresholds" })).toBeVisible();
  await page.getByLabel("Soft limit (% used)").fill("80");
  await page.getByLabel("Minimum free space (%)").fill("5");
  await page.getByRole("button", { name: "Continue" }).click();

  // 7 External players
  await expect(page.getByRole("heading", { level: 1, name: "External players" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Xtream Codes API" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "M3U playlist" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();

  // 8 First source: skip
  await expect(page.getByRole("heading", { level: 1, name: "First source" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();

  // 9 Finish
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Setup is finished" })).toBeVisible();
  await page.getByRole("link", { name: "Open dashboard" }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
