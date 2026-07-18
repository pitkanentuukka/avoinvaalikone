// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("NGO submission UI", () => {
  test("submit a question set", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Järjestö" }).click();

    await expect(page.getByText("Lähetä kysymyksiä")).toBeVisible();

    // Fill in the form
    await page.getByPlaceholder("esim. Ilmastotoimintaverkosto").fill("E2E Järjestö");
    await page.getByPlaceholder("info@jarjesto.fi").fill("e2e@ngo.fi");
    await page.getByPlaceholder("esim. Ilmasto- ja energiapolitiikka").fill(`E2E Kysymykset ${Date.now()}`);

    // Fill first question
    await page.getByPlaceholder("Suomen tulee...").first().fill("Verotusta tulee keventää");

    // Add another question
    await page.getByRole("button", { name: "+ Lisää väittämä" }).click();
    await page.getByPlaceholder("Suomen tulee...").last().fill("Koulutukseen tulee panostaa");

    // Submit
    await page.getByRole("button", { name: "Lähetä tarkistettavaksi" }).click();

    // Should show success message
    await expect(page.getByText("Lähetetty tarkistettavaksi")).toBeVisible();
    await expect(page.getByText("Kysymyssarjasi on lähetetty ylläpidolle")).toBeVisible();
  });

  test("submit button disabled when form is incomplete", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Järjestö" }).click();

    const submitBtn = page.getByRole("button", { name: "Lähetä tarkistettavaksi" });
    await expect(submitBtn).toBeDisabled();

    // Fill only name
    await page.getByPlaceholder("esim. Ilmastotoimintaverkosto").fill("Test");
    await expect(submitBtn).toBeDisabled();

    // Fill title
    await page.getByPlaceholder("esim. Ilmasto- ja energiapolitiikka").fill("Test title");
    await expect(submitBtn).toBeDisabled();

    // Fill a question
    await page.getByPlaceholder("Suomen tulee...").first().fill("Question 1");
    await expect(submitBtn).toBeEnabled();
  });

  test("can submit another set after first", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Järjestö" }).click();

    await page.getByPlaceholder("esim. Ilmastotoimintaverkosto").fill("Another NGO");
    await page.getByPlaceholder("esim. Ilmasto- ja energiapolitiikka").fill(`Another ${Date.now()}`);
    await page.getByPlaceholder("Suomen tulee...").first().fill("Another question");
    await page.getByRole("button", { name: "Lähetä tarkistettavaksi" }).click();

    await expect(page.getByText("Lähetetty tarkistettavaksi")).toBeVisible();

    // Click "send another"
    await page.getByRole("button", { name: "Lähetä toinen sarja" }).click();

    // Should be back on the form
    await expect(page.getByText("Lähetä kysymyksiä")).toBeVisible();
    // Form should be empty
    await expect(page.getByPlaceholder("esim. Ilmastotoimintaverkosto")).toHaveValue("");
  });

  test("remove question button works", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Järjestö" }).click();

    // Add a second question
    await page.getByRole("button", { name: "+ Lisää väittämä" }).click();
    const textareas = page.getByPlaceholder("Suomen tulee...");
    await expect(textareas).toHaveCount(2);

    // Remove the first question (click the × button)
    await page.locator("button").filter({ hasText: "×" }).first().click();
    await expect(page.getByPlaceholder("Suomen tulee...")).toHaveCount(1);
  });
});
