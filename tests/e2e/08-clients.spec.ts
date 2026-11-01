import { test, expect, type Page } from "@playwright/test";
import { API, login } from "./helpers";

async function creds(page: Page) {
  const dialog = page.getByRole("dialog");
  const read = async (label: string) => (await dialog.getByText(label, { exact: true }).locator("xpath=following-sibling::p").innerText()).trim();
  return { server: await read("Server URL"), username: await read("Username"), password: await read("Password") };
}

async function auth(request: import("@playwright/test").APIRequestContext, u: string, p: string) {
  const r = await request.get(`${API}/player_api.php`, { params: { username: u, password: p } });
  const text = await r.text();
  try {
    return { status: r.status(), auth: JSON.parse(text)?.user_info?.auth ?? 0 };
  } catch {
    return { status: r.status(), auth: 0 };
  }
}

test("external client: create, authenticate, rotate, revoke", async ({ page, request }) => {
  await login(page);
  await page.goto("/admin/clients");
  await expect(page.getByRole("heading", { level: 1, name: "External players" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Add player" }).first().click();
  await page.getByRole("dialog", { name: "Add an external player" }).getByLabel("Name").fill("E2E UHF");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: /Player created: E2E UHF/ });
  await expect(dialog).toBeVisible();
  const c1 = await creds(page);
  expect(c1.server).toMatch(/^https?:\/\//);
  expect(c1.username).toBeTruthy();
  expect(c1.password.length).toBeGreaterThan(8);
  await dialog.getByRole("button", { name: "I've saved the password" }).click();
  await expect(dialog).toBeHidden();

  expect((await auth(request, c1.username, c1.password)).auth).toBe(1);
  expect((await auth(request, c1.username, "wrong-password")).auth).toBe(0);

  // Rotate: the old password stops working, the new one works.
  await page.getByRole("button", { name: /Rotate password for E2E UHF/ }).click();
  const rotated = page.getByRole("dialog", { name: /New password: E2E UHF/ });
  await expect(rotated).toBeVisible();
  const c2 = await creds(page);
  expect(c2.password).not.toBe(c1.password);
  await rotated.getByRole("button", { name: "I've saved the password" }).click();
  expect((await auth(request, c1.username, c1.password)).auth).toBe(0);
  expect((await auth(request, c2.username, c2.password)).auth).toBe(1);

  // Revoke.
  await page.getByRole("button", { name: /Revoke E2E UHF/ }).click();
  await page.getByRole("dialog", { name: /Revoke E2E UHF/ }).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Revoke/ })).toBeHidden();
  await expect
    .poll(async () => ((await (await page.request.get("/api/clients")).json()).items as any[]).some((c) => c.name === "E2E UHF"))
    .toBe(false);
  await expect(page.getByRole("row").filter({ hasText: "E2E UHF" })).toHaveCount(0);
  expect((await auth(request, c2.username, c2.password)).auth).toBe(0);
});
