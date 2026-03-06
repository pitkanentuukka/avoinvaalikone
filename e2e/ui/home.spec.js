// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Home page", () => {
  test("renders header and navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
    await expect(page.getByText("Vaalikone")).toBeVisible();
    await expect(page.getByText("2026")).toBeVisible();
  });

  test("shows three main cards: voter, NGO, candidate", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Löydä ehdokkaasi")).toBeVisible();
    await expect(page.getByText("Vertaile ehdokkaita")).toBeVisible();
    await expect(page.getByText("Lähetä kysymyksiä")).toBeVisible();
    await expect(page.getByText("Vastaa kysymyksiin")).toBeVisible();
  });

  test("navigation buttons work", async ({ page }) => {
    await page.goto("/");

    // Click "Äänestäjä" in nav
    await page.getByRole("button", { name: "Äänestäjä" }).click();
    await expect(page.getByText("Tallennetaanko vastauksesi?").or(page.getByText("Valitse aiheet"))).toBeVisible();

    // Click "Järjestö" in nav
    await page.getByRole("button", { name: "Järjestö" }).click();
    await expect(page.getByText("Lähetä kysymyksiä")).toBeVisible();

    // Click "Ylläpito" in nav
    await page.getByRole("button", { name: "Ylläpito" }).click();
    await expect(page.getByText("Ylläpidon kirjautuminen")).toBeVisible();

    // Click logo to go back home
    await page.getByText("Vaalikone").first().click();
    await expect(page.getByText("Löydä ehdokkaasi")).toBeVisible();
  });

  test("candidate token input and navigation", async ({ page }) => {
    await page.goto("/");

    // The "Siirry" button should be disabled without input
    const goButton = page.getByRole("button", { name: "Siirry" });
    await expect(goButton).toBeDisabled();

    // Type a token
    await page.getByPlaceholder("esim. sd-2026-x7k9").fill("some-token");
    await expect(goButton).toBeEnabled();
  });
});
