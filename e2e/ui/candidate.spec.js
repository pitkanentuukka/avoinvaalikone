// @ts-check
const { test, expect } = require("@playwright/test");
const { createParty, createCandidate, submitQuestionSet, approveQuestionSet } = require("../helpers");

test.describe("Candidate and party portal UI", () => {
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
    await page.getByPlaceholder("Linkki tai tunniste").fill("nonexistent-token");
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Linkki ei kelpaa")).toBeVisible();
  });

  test("party token opens the party portal with the registration link", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Linkki tai tunniste").fill(party.token);
    await page.getByRole("button", { name: "Siirry" }).click();

    await expect(page.getByText("Puolueportaali")).toBeVisible();
    await expect(page.getByText(party.name)).toBeVisible();
    await expect(page.locator(`input[value$="?register=${party.registration_token}"]`)).toBeVisible();
  });

  test("register through the registration link and answer questions", async ({ page }) => {
    await page.goto(`/?register=${party.registration_token}`);
    // The token is scrubbed from the address bar once read.
    await expect(page).not.toHaveURL(/register=/);

    await expect(page.getByText("Rekisteröidy ehdokkaaksi")).toBeVisible();
    await page.getByPlaceholder("esim. Matti Meikäläinen").fill("UI Testiehdokas");
    await page.getByPlaceholder("etunimi.sukunimi@esimerkki.fi").fill("ui@test.fi");
    await page.locator("select").filter({ hasText: "esim. Helsingin vaalipiiri" }).selectOption("Helsingin vaalipiiri");
    await page.getByRole("button", { name: "Rekisteröidy" }).click();

    // Straight into the candidate's own page, with their personal link shown.
    await expect(page.getByText("Henkilökohtainen linkkisi")).toBeVisible();
    await expect(page.locator('input[value*="?candidateToken="]')).toBeVisible();

    const q1Text = page.getByText("UI Väittämä 1").first();
    await q1Text.scrollIntoViewIfNeeded();
    const q1Card = q1Text.locator("xpath=ancestor::div[contains(@style,'border-radius')]").first();
    await q1Card.getByRole("button", { name: "Samaa mieltä", exact: true }).click();
    const q2Card = page.getByText("UI Väittämä 2").first().locator("xpath=ancestor::div[contains(@style,'border-radius')]").first();
    await q2Card.getByRole("button", { name: "Eri mieltä", exact: true }).click();

    await page.getByRole("button", { name: /Tallenna vastaukset/ }).first().click();
    await expect(page.getByText("Vastaukset tallennettu")).toBeVisible();
    await expect(page.getByText("UI Testiehdokas")).toBeVisible();
  });

  test("personal link reopens the candidate's own answers", async ({ page, request }) => {
    const candidate = await createCandidate(request, party, { name: "Linkki Ehdokas" });

    await page.goto(`/?candidateToken=${candidate.token}`);
    await expect(page).not.toHaveURL(/candidateToken=/);
    await expect(page.getByText("Vastaa kysymyksiin")).toBeVisible();
    await expect(page.getByPlaceholder("esim. Matti Meikäläinen")).toHaveValue("Linkki Ehdokas");
    // Only on first registration is the "save your link" banner shown.
    await expect(page.getByText("Henkilökohtainen linkkisi")).toHaveCount(0);

    // The token is gone from the URL, but a reload reopens the same page.
    await page.reload();
    await expect(page.getByPlaceholder("esim. Matti Meikäläinen")).toHaveValue("Linkki Ehdokas");

    // A fresh visit to the site in the same tab doesn't.
    await page.goto("/");
    await expect(page.getByPlaceholder("Linkki tai tunniste")).toBeVisible();
    await expect(page.getByPlaceholder("esim. Matti Meikäläinen")).toHaveCount(0);
  });

  test("the explanation box opens only once a position is chosen", async ({ page, request }) => {
    const candidate = await createCandidate(request, party, { name: "Perustelu Ehdokas" });
    await page.goto(`/?candidateToken=${candidate.token}`);

    // An explanation is only sent along with a position, so typing one first
    // would be lost on save (#38).
    // Other specs reuse these statements, so scope to this set's cards.
    const card = (statement) => page.getByText(statement).first().locator("xpath=ancestor::div[contains(@style,'border-radius')]").first();
    const q1Card = card("UI Väittämä 1");
    const explanation = q1Card.getByRole("textbox", { name: /Perustele kantasi/ });
    await expect(explanation).toBeDisabled();
    await expect(explanation).toHaveAccessibleDescription(/Valitse ensin kantasi/);

    await q1Card.getByRole("button", { name: "Samaa mieltä", exact: true }).click();
    await expect(explanation).toBeEnabled();
    await expect(q1Card.getByText(/Valitse ensin kantasi/)).toHaveCount(0);
    await explanation.fill("Koska näin on.");
    // The other question still has no position, so its box stays closed.
    await expect(card("UI Väittämä 2").getByRole("textbox", { name: /Perustele kantasi/ })).toBeDisabled();

    await page.getByRole("button", { name: /Tallenna vastaukset/ }).first().click();
    await expect(page.getByText("Vastaukset tallennettu")).toBeVisible();
    await page.reload();
    await expect(explanation).toHaveValue("Koska näin on.");
  });

  test("a temporary load error offers a retry instead of \"invalid link\"", async ({ page, request }) => {
    const candidate = await createCandidate(request, party, { name: "Retry Ehdokas" });
    await page.route("**/api/candidates/me/*", (route) => route.fulfill({ status: 500, body: "{}" }));

    await page.goto(`/?candidateToken=${candidate.token}`);
    await expect(page.getByText("Sivun lataaminen epäonnistui")).toBeVisible();
    await expect(page.getByText("Linkki ei kelpaa")).toHaveCount(0);

    await page.unroute("**/api/candidates/me/*");
    await page.getByRole("button", { name: "Yritä uudelleen" }).click();
    await expect(page.getByPlaceholder("esim. Matti Meikäläinen")).toHaveValue("Retry Ehdokas");
  });

  test("leaving with unsaved answers asks first", async ({ page, request }) => {
    const candidate = await createCandidate(request, party, { name: "Unsaved Ehdokas" });
    await page.goto(`/?candidateToken=${candidate.token}`);
    await page.getByPlaceholder("esim. Matti Meikäläinen").fill("Unsaved Ehdokas 2");

    const dialog = page.waitForEvent("dialog");
    await page.getByRole("button", { name: "Etusivu" }).click();
    const d = await dialog;
    expect(d.message()).toContain("tallentamattomia muutoksia");
    await d.dismiss();
    await expect(page.getByPlaceholder("esim. Matti Meikäläinen")).toHaveValue("Unsaved Ehdokas 2");
  });

  test("registered candidates appear in the party portal", async ({ page, request }) => {
    await createCandidate(request, party, { name: "Existing Candidate" });

    await page.goto(`/?partyToken=${party.token}`);
    await expect(page.getByText("Puolueportaali")).toBeVisible();
    await expect(page.getByText("Existing Candidate")).toBeVisible();
    await expect(page.getByRole("button", { name: "Lähetä linkki" }).first()).toBeVisible();
  });
});
