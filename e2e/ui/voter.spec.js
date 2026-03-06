// @ts-check
const { test, expect } = require("@playwright/test");
const { fullSetup } = require("../helpers");

test.describe("Voter quiz UI", () => {
  let setup;

  // Increase timeout — many questions from previous test runs may exist
  test.setTimeout(120_000);

  let ts;
  test.beforeAll(async ({ request }) => {
    ts = Date.now();
    setup = await fullSetup(request, {
      partyName: `UIVoter ${ts}`,
      title: `UI Kysymykset ${ts}`,
      candidateName: "UI Match Candidate",
      answerValues: [4, 2, 0],
    });
  });

  /** Answer all visible questions by clicking "Neutraali" until weighting step */
  async function answerAllQuestions(page) {
    while (await page.getByRole("button", { name: "Neutraali" }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Neutraali" }).click();
      await page.waitForTimeout(50);
    }
  }

  test("voter flow: consent -> select -> answer -> weight -> results", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Äänestäjä" }).click();

    // Step 1: GDPR consent
    await expect(page.getByText("Tallennetaanko vastauksesi?")).toBeVisible();
    await page.getByRole("button", { name: "Älä tallenna" }).click();

    // Step 2: Select question sets
    await expect(page.getByText("Valitse aiheet")).toBeVisible();

    // Start answering (all sets are pre-selected)
    await page.getByRole("button", { name: /Aloita/ }).click();

    // Step 3: Answer all questions
    await answerAllQuestions(page);

    // Step 4: Weighting
    await expect(page.getByText("Kuinka tärkeä kukin aihe on sinulle?")).toBeVisible();
    await page.getByRole("button", { name: "Näytä tulokset" }).click();

    // Step 5: Results
    await expect(page.getByText("Tuloksesi")).toBeVisible();
    // Our candidate should appear
    await expect(page.getByText("UI Match Candidate").first()).toBeVisible();
    // Match percentage should be visible
    await expect(page.getByText("%").first()).toBeVisible();
  });

  test("consent: allow storage saves to localStorage", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Äänestäjä" }).click();

    await expect(page.getByText("Tallennetaanko vastauksesi?")).toBeVisible();
    await page.getByRole("button", { name: "Salli tallennus" }).click();

    // Consent should be in localStorage
    const consent = await page.evaluate(() => localStorage.getItem("vaalikone_consent"));
    expect(consent).toBe("true");
  });

  test("voter can view candidate profile from results", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Äänestäjä" }).click();

    // Skip consent
    await page.getByRole("button", { name: "Älä tallenna" }).click();

    // Start answering
    await page.getByRole("button", { name: /Aloita/ }).click();

    // Answer all questions
    await answerAllQuestions(page);

    // Skip weighting
    await page.getByRole("button", { name: "Näytä tulokset" }).click();

    // Click on a candidate to see profile
    const candidateCard = page.getByText("UI Match Candidate");
    if (await candidateCard.isVisible()) {
      await candidateCard.click();
      // Should show profile modal or expanded view
      await expect(page.getByText(setup.party.name).or(page.getByText("Esittely").or(page.getByText("Vastaukset")))).toBeVisible();
    }
  });
});
