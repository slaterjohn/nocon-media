import { test, expect } from "@playwright/test";
import { CHANNEL_URL, login } from "./helpers";

// The source is named after its id until the first sync fetches the channel title.
const CHAN = /UCfakechannel0000000000a|Fake Channel/;

test.describe.serial("sources", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/admin/sources");
    await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
  });

  test("add the fake channel with defaults", async ({ page }) => {
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a source" });
    await dialog.getByLabel("Address or handle").fill(CHANNEL_URL);
    await expect(dialog.getByText(/Recognised a youtube channel/)).toBeVisible();
    // Defaults: Keep (P1), keep everything, automatic eviction on.
    await expect(dialog.getByRole("radio", { name: /^Keep/ })).toBeChecked();
    await expect(dialog.getByLabel("Retention mode")).toHaveValue("all");
    await dialog.getByRole("button", { name: /^Advanced settings/ }).click();
    await expect(dialog.getByRole("switch", { name: "Automatic eviction" })).toBeChecked();
    await dialog.getByRole("button", { name: "Add source" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("row").filter({ hasText: CHAN });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Keep");
  });

  test("edit rules: latest 2, weekly, keyword filter", async ({ page }) => {
    const row = page.getByRole("row").filter({ hasText: CHAN });
    await row.getByRole("button", { name: /^Edit/ }).click();
    const dialog = page.getByRole("dialog", { name: /Edit/ });
    await dialog.getByLabel("Retention mode").selectOption("latest_n");
    await dialog.getByLabel("Number of videos").fill("2");
    await dialog.getByLabel("How often to check for new videos").selectOption("weekly");
    // Filters live under Advanced settings, which starts closed.
    const advanced = dialog.getByRole("button", { name: /^Advanced settings/ });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByLabel("Required keywords")).toBeHidden();
    await advanced.click();
    await dialog.getByLabel("Required keywords").fill("fake");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: CHAN })).toContainText("Latest 2");
    await expect(page.getByRole("row").filter({ hasText: CHAN })).toContainText(/weekly/i);

    const list = await (await page.request.get("/api/sources")).json();
    const src = list.items.find((s: any) => s.externalId === "UCfakechannel0000000000a");
    expect(src.retention).toMatchObject({ mode: "latest_n", count: 2 });
    expect(src.schedule.kind).toBe("weekly");
    expect(JSON.stringify(src.filters)).toContain("fake");
  });

  test("pause, resume and sync now", async ({ page }) => {
    const row = () => page.getByRole("row").filter({ hasText: CHAN });
    await row().getByRole("button", { name: /^Pause/ }).click();
    await expect(row().getByRole("button", { name: /^Resume/ })).toBeVisible();
    await expect(row().getByRole("button", { name: /^Sync now/ })).toBeDisabled();
    await row().getByRole("button", { name: /^Resume/ }).click();
    await expect(row().getByRole("button", { name: /^Pause/ })).toBeVisible();
    await row().getByRole("button", { name: /^Sync now/ }).click();
    await expect(page.getByText(/Sync started for/).first()).toBeVisible();
  });

  test("automatic download switch: on by default, saved when off, shown on edit", async ({ page }) => {
    const PLAYLIST = "https://www.youtube.com/playlist?list=PLfakeplaylist0001";
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add a source" });
    await dialog.getByLabel("Address or handle").fill(PLAYLIST);
    await expect(dialog.getByText(/Recognised a youtube playlist/)).toBeVisible();
    await dialog.getByRole("button", { name: /^Advanced settings/ }).click();
    const sw = dialog.getByRole("switch", { name: "Download new videos automatically" });
    await expect(sw).toBeChecked();
    await expect(dialog.getByText(/new videos from this source are listed but not downloaded/)).toBeVisible();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await dialog.getByRole("button", { name: "Add source" }).click();
    await expect(dialog).toBeHidden();

    const list = await (await page.request.get("/api/sources")).json();
    const src = list.items.find((s: any) => s.externalId === "PLfakeplaylist0001");
    expect(src.autoDownload).toBe(false);

    try {
      await page.reload();
      const row = page.getByRole("row").filter({ hasText: /PLfakeplaylist0001|Fake Playlist/ });
      await row.getByRole("button", { name: /^Edit/ }).click();
      const edit = page.getByRole("dialog", { name: /Edit/ });
      await edit.getByRole("button", { name: /^Advanced settings/ }).click();
      await expect(edit.getByRole("switch", { name: "Download new videos automatically" })).not.toBeChecked();
    } finally {
      const del = await page.request.delete(`/api/sources/${src.id}?media=delete`, { headers: { "X-NoCon-CSRF": "1" } });
      expect(del.ok()).toBeTruthy();
    }
  });
});
