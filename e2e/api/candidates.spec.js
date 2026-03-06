// @ts-check
const { test, expect } = require("@playwright/test");
const {
  get,
  post,
  put,
  createParty,
  createCandidate,
  submitQuestionSet,
  approveQuestionSet,
  saveAnswers,
} = require("../helpers");

test.describe("UC-CAND: Candidate management (party-token gated)", () => {
  let party;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `CandParty ${Date.now()}`);
  });

  test("UC-CAND-1: view party's candidates (empty)", async ({ request }) => {
    const { res, body } = await get(
      request,
      `/candidates/party/${party.token}`
    );
    expect(res.status()).toBe(200);
    expect(body.party.name).toBe(party.name);
    expect(body.candidates).toHaveLength(0);
  });

  test("UC-CAND-2: register a new candidate", async ({ request }) => {
    const { res, body } = await post(
      request,
      `/candidates/party/${party.token}`,
      {
        name: "Matti Meikäläinen",
        bio: "Kokenut kunnallispoliitikko",
        photoUrl: "https://example.com/photo.jpg",
        email: "matti@example.fi",
      }
    );
    expect(res.status()).toBe(201);
    expect(body.name).toBe("Matti Meikäläinen");
    expect(body.id).toBeTruthy();
    expect(body.email).toBe("matti@example.fi");
  });

  test("UC-CAND-1: view party's candidates (with candidates)", async ({ request }) => {
    const { body } = await get(
      request,
      `/candidates/party/${party.token}`
    );
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.candidates[0].answer_count).toBeDefined();
  });

  test("register candidate without name returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      `/candidates/party/${party.token}`,
      { name: "" }
    );
    expect(res.status()).toBe(400);
  });

  test("register candidate with too-long name returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      `/candidates/party/${party.token}`,
      { name: "A".repeat(256) }
    );
    expect(res.status()).toBe(400);
  });

  test("register candidate with invalid photo URL returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      `/candidates/party/${party.token}`,
      { name: "Test", photoUrl: "not-a-url" }
    );
    expect(res.status()).toBe(400);
  });

  test("register candidate with too-long bio returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      `/candidates/party/${party.token}`,
      { name: "Test", bio: "A".repeat(1001) }
    );
    expect(res.status()).toBe(400);
  });

  test("register candidate with invalid email returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      `/candidates/party/${party.token}`,
      { name: "Test", email: "bad-email" }
    );
    expect(res.status()).toBe(400);
  });

  test("invalid party token returns 404", async ({ request }) => {
    const { res } = await get(request, "/candidates/party/nonexistent-token");
    expect(res.status()).toBe(404);
  });
});

test.describe("UC-CAND-3: Update candidate profile", () => {
  let party, candidate;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `UpdateParty ${Date.now()}`);
    candidate = await createCandidate(request, party.token, {
      name: "Original Name",
    });
  });

  test("update candidate name and bio", async ({ request }) => {
    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}`,
      { name: "Updated Name", bio: "New bio" }
    );
    expect(res.status()).toBe(200);
    expect(body.name).toBe("Updated Name");
    expect(body.bio).toBe("New bio");
  });

  test("null photoUrl clears the field", async ({ request }) => {
    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}`,
      { photoUrl: null }
    );
    expect(res.status()).toBe(200);
    expect(body.photo_url).toBeNull();
  });

  test("update candidate from wrong party returns 404", async ({ request }) => {
    const otherParty = await createParty(request, `OtherParty ${Date.now()}`);
    const { res } = await put(
      request,
      `/candidates/party/${otherParty.token}/candidates/${candidate.id}`,
      { name: "Hacker" }
    );
    expect(res.status()).toBe(404);
  });

  test("update with too-long name returns 400", async ({ request }) => {
    const { res } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}`,
      { name: "A".repeat(256) }
    );
    expect(res.status()).toBe(400);
  });
});

test.describe("UC-CAND-4: Save candidate answers", () => {
  let party, candidate, questions;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `AnswerParty ${Date.now()}`);
    candidate = await createCandidate(request, party.token, {
      name: "Answer Candidate",
    });
    const qs = await submitQuestionSet(request, {
      ngoName: "AnswerNGO",
      title: `Answers ${Date.now()}`,
      questions: ["Väittämä 1", "Väittämä 2"],
    });
    await approveQuestionSet(request, qs.id);
    questions = qs.questions;
  });

  test("save answers (initial)", async ({ request }) => {
    const answers = {};
    answers[questions[0].id] = { value: 4, explanation: "Täysin samaa mieltä" };
    answers[questions[1].id] = { value: 1, explanation: "" };

    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}/answers`,
      { answers }
    );
    expect(res.status()).toBe(200);
    expect(body.saved).toBe(2);
  });

  test("upsert answers (update existing)", async ({ request }) => {
    const answers = {};
    answers[questions[0].id] = { value: 0, explanation: "Changed my mind" };

    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}/answers`,
      { answers }
    );
    expect(res.status()).toBe(200);
    expect(body.saved).toBe(1);

    // Verify via public endpoint
    const { body: full } = await get(request, `/candidates/${candidate.id}`);
    expect(full.answers[questions[0].id].value).toBe(0);
    expect(full.answers[questions[0].id].explanation).toBe("Changed my mind");
  });

  test("answers from wrong party returns 404", async ({ request }) => {
    const otherParty = await createParty(request, `WrongParty ${Date.now()}`);
    const { res } = await put(
      request,
      `/candidates/party/${otherParty.token}/candidates/${candidate.id}/answers`,
      { answers: {} }
    );
    expect(res.status()).toBe(404);
  });

  test("missing answers object returns 400", async ({ request }) => {
    const { res } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}/answers`,
      {}
    );
    expect(res.status()).toBe(400);
  });

  test("invalid answer values are silently skipped", async ({ request }) => {
    const answers = {};
    answers[questions[0].id] = { value: 99, explanation: "" };

    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}/answers`,
      { answers }
    );
    expect(res.status()).toBe(200);
    expect(body.saved).toBe(0);
  });

  test("invalid UUID question IDs are silently skipped", async ({ request }) => {
    const { res, body } = await put(
      request,
      `/candidates/party/${party.token}/candidates/${candidate.id}/answers`,
      { answers: { "not-a-uuid": { value: 2, explanation: "" } } }
    );
    expect(res.status()).toBe(200);
    expect(body.saved).toBe(0);
  });
});

test.describe("Public candidate endpoints", () => {
  test("UC-VOTER-2: list all candidates", async ({ request }) => {
    const { res, body } = await get(request, "/candidates");
    expect(res.status()).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  test("UC-VOTER-3: get single candidate with answers", async ({ request }) => {
    const party = await createParty(request, `SingleParty ${Date.now()}`);
    const candidate = await createCandidate(request, party.token, {
      name: "Solo Candidate",
      bio: "Bio text",
    });

    const { res, body } = await get(request, `/candidates/${candidate.id}`);
    expect(res.status()).toBe(200);
    expect(body.name).toBe("Solo Candidate");
    expect(body.bio).toBe("Bio text");
    expect(body.party_name).toBe(party.name);
    expect(body.answers).toBeDefined();
  });

  test("get non-existent candidate returns 404", async ({ request }) => {
    const { res } = await get(
      request,
      "/candidates/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status()).toBe(404);
  });

  test("get candidate with invalid UUID returns 400", async ({ request }) => {
    const { res } = await get(request, "/candidates/not-a-uuid");
    expect(res.status()).toBe(400);
  });
});
