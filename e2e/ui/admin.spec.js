// @ts-check
const { test, expect } = require("@playwright/test");
const { submitQuestionSet, ADMIN_SECRET } = require("../helpers");

test.describe("Admin UI", () => {
  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Ylläpito" }).click();

    await page.getByPlaceholder("Ylläpidon salasana").fill("wrong-password");
    await page.getByRole("button", { name: "Kirjaudu" }).click();

    await expect(page.getByText("Virheellinen ylläpitotunniste")).toBeVisible();
  });

  test("login with correct password shows admin panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Ylläpito" }).click();

    await page.getByPlaceholder("Ylläpidon salasana").fill(ADMIN_SECRET);
    await page.getByRole("button", { name: "Kirjaudu" }).click();

    await expect(page.getByText("Ylläpidon hallintapaneeli")).toBeVisible();
    await expect(page.getByText("Puolueet ja tunnisteet")).toBeVisible();
  });

  test("create a party from admin panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Ylläpito" }).click();
    await page.getByPlaceholder("Ylläpidon salasana").fill(ADMIN_SECRET);
    await page.getByRole("button", { name: "Kirjaudu" }).click();

    await expect(page.getByText("Ylläpidon hallintapaneeli")).toBeVisible();

    const partyName = `UI Puolue ${Date.now()}`;
    await page.getByPlaceholder("Puolueen nimi").fill(partyName);
    await page.getByPlaceholder("Sihteerin sähköposti").fill("test@ui.fi");
    await page.getByRole("button", { name: "Lisää" }).click();

    // Party should appear in the list
    await expect(page.getByText(partyName)).toBeVisible();
  });

  test("approve a pending question set from admin panel", async ({ page, request }) => {
    // Create a pending question set via API
    const ts = Date.now();
    const qs = await submitQuestionSet(request, {
      ngoName: "UI Admin NGO",
      title: `UI Pending ${ts}`,
      questions: ["UI Väittämä 1"],
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Ylläpito" }).click();
    await page.getByPlaceholder("Ylläpidon salasana").fill(ADMIN_SECRET);
    await page.getByRole("button", { name: "Kirjaudu" }).click();

    await expect(page.getByText("Ylläpidon hallintapaneeli")).toBeVisible();

    // Find the pending set and approve it — scroll to it first
    const titleEl = page.getByText(`UI Pending ${ts}`);
    await titleEl.scrollIntoViewIfNeeded();
    await expect(titleEl).toBeVisible();

    // The approve button is in the same card as the title
    const card = titleEl.locator("xpath=ancestor::div[contains(@style,'border')]").first();
    await card.getByRole("button", { name: "Hyväksy" }).click();

    // Should show approved status
    await expect(page.getByText("Hyväksytyt")).toBeVisible();
  });
});
