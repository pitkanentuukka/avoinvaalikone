// @ts-check
const { test, expect } = require("@playwright/test");
const { createParty, submitQuestionSet, approveQuestionSet } = require("../helpers");

test.describe("Candidate portal UI", () => {
  let party;
  let questionSet;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `UICandidate ${Date.now()}`);
    questionSet = await submitQuestionSet(request, {
      ngoName: "CandUI NGO",
      title: `CandUI ${Date.now()}`,
      questions: ["UI Väittämä 1", "UI Väittämä 2"],
    });
    await approveQuestionSet(request, questionSet.id);
  });

  test("invalid token shows error", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("esim. sd-2026-x7k9").fill("nonexistent-token");
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Virheellinen tunniste")).toBeVisible();
  });

  test("valid token shows candidate portal", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("esim. sd-2026-x7k9").fill(party.token);
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Ehdokasportaali")).toBeVisible();
    await expect(page.getByText(party.name)).toBeVisible();
    await expect(page.getByRole("button", { name: "Rekisteröidy uutena ehdokkaana" })).toBeVisible();
  });

  test("register new candidate and answer questions", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("esim. sd-2026-x7k9").fill(party.token);
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Ehdokasportaali")).toBeVisible();

    // Click register new
    await page.getByRole("button", { name: "Rekisteröidy uutena ehdokkaana" }).click();

    await expect(page.getByText("Vastaa kysymyksiin")).toBeVisible();

    // Fill profile
    await page.getByPlaceholder("esim. Matti Meikäläinen").fill("UI Testiehdokas");
    await page.getByPlaceholder("etunimi.sukunimi@esimerkki.fi").fill("ui@test.fi");

    // Scroll to our question set section and answer questions
    const q1Text = page.getByText("UI Väittämä 1").first();
    await q1Text.scrollIntoViewIfNeeded();

    // Answer first question — click "Samaa mieltä" (value 3) in the same Card
    const q1Card = q1Text.locator("xpath=ancestor::div[contains(@style,'border-radius')]").first();
    await q1Card.getByRole("button", { name: "Samaa mieltä", exact: true }).click();

    // Answer second question — click "Eri mieltä" (value 1)
    const q2Text = page.getByText("UI Väittämä 2").first();
    const q2Card = q2Text.locator("xpath=ancestor::div[contains(@style,'border-radius')]").first();
    await q2Card.getByRole("button", { name: "Eri mieltä", exact: true }).click();

    // Save
    await page.getByRole("button", { name: /Tallenna vastaukset/ }).first().click();

    // Should show success
    await expect(page.getByText("Vastaukset tallennettu")).toBeVisible();
    await expect(page.getByText("UI Testiehdokas")).toBeVisible();
  });

  test("existing candidate appears in portal list", async ({ page, request }) => {
    // Create a candidate via API first
    const { createCandidate } = require("../helpers");
    const candidate = await createCandidate(request, party.token, {
      name: "Existing Candidate",
    });

    await page.goto("/");
    await page.getByPlaceholder("esim. sd-2026-x7k9").fill(party.token);
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Ehdokasportaali")).toBeVisible();
    await expect(page.getByText("Existing Candidate")).toBeVisible();
  });
});
