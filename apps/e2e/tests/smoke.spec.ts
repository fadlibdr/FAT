import { test, expect } from "@playwright/test";

test.describe("FAT Desk smoke", () => {
  test("logs in and creates a ToDo end-to-end", async ({ page }) => {
    // Login form is pre-filled with the seeded admin credentials.
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const desc = `E2E todo ${Date.now()}`;
    await page.goto("/app/ToDo/new");
    await page.locator("textarea").first().fill(desc);
    await page.getByRole("button", { name: "Save" }).click();

    // On create we navigate to the saved record.
    await page.waitForURL(/\/app\/ToDo\/[^/]+$/);

    // And it shows up in the list.
    await page.goto("/app/ToDo");
    await expect(page.getByText(desc)).toBeVisible();
  });
});
