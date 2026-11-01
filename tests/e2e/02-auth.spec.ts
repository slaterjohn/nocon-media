import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, login } from "./helpers";

test.describe.serial("auth", () => {
  test("logged in after setup, then logout", async ({ page }) => {
    // Session cookie from the setup test is not shared (new context), so sign in first.
    await login(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const userMenu = page.getByRole("button", { name: /account|user|menu|e2eadmin/i }).first();
    await userMenu.click();
    await page.getByRole("menuitem", { name: /sign out|log ?out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated visit to /admin redirects to /login", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("failed login shows an error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN_USER);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /wrong/i })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("login works", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill(ADMIN_USER);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin/);
  });
});
