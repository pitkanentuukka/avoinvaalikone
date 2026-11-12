// @ts-check
const { test, expect } = require("@playwright/test");
const {
  get,
  post,
  put,
  del,
  createParty,
  createCandidate,
  submitQuestionSet,
  approveQuestionSet,
  saveAnswers,
} = require("../helpers");

const PROFILE = {
  name: "Matti Meikäläinen",
  bio: "Kokenut kunnallispoliitikko",
  photoUrl: "https://example.com/photo.jpg",
  email: "matti@example.fi",
  constituency: "Helsingin vaalipiiri",
};

test.describe("UC-CAND-REG: Candidate self-registration (registration link)", () => {
  let party;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `RegParty ${Date.now()}`);
  });

  test("admin party creation returns a registration token", async () => {
    expect(party.registration_token).toMatch(/^[0-9a-f]{48}$/);
    expect(party.registration_token).not.toBe(party.token);
  });

  test("registration link shows the party name only", async ({ request }) => {
    const { res, body } = await get(request, `/candidates/register/${party.registration_token}`);
    expect(res.status()).toBe(200);
    expect(body).toEqual({ party: { name: party.name } });
  });

  test("invalid registration link returns 404", async ({ request }) => {
    const { res } = await get(request, "/candidates/register/nonexistent");
    expect(res.status()).toBe(404);
  });

  test("register → 201 with a personal token, visible to voters immediately", async ({ request }) => {
    const { res, body } = await post(request, `/candidates/register/${party.registration_token}`, PROFILE);
    expect(res.status()).toBe(201);
    expect(body.name).toBe(PROFILE.name);
    expect(body.token).toMatch(/^[0-9a-f]{48}$/);

    const { body: pub } = await get(request, `/candidates/${body.id}`);
    expect(pub.name).toBe(PROFILE.name);
    expect(pub.party_name).toBe(party.name);
    expect(pub).not.toHaveProperty("token");
    expect(pub).not.toHaveProperty("email");
  });

  test("same name + email again → 409, no duplicate, no token leaked", async ({ request }) => {
    const { res, body } = await post(request, `/candidates/register/${party.registration_token}`, {
      ...PROFILE,
      email: PROFILE.email.toUpperCase(),
    });
    expect(res.status()).toBe(409);
    expect(body).not.toHaveProperty("token");

    const { body: overview } = await get(request, `/candidates/party/${party.token}`);
    expect(overview.candidates.filter((c) => c.name === PROFILE.name)).toHaveLength(1);
  });

  test("same email, different name → allowed (shared office address)", async ({ request }) => {
    const { res } = await post(request, `/candidates/register/${party.registration_token}`, {
      ...PROFILE,
      name: "Maija Meikäläinen",
    });
    expect(res.status()).toBe(201);
  });

  for (const [label, body] of [
    ["missing name", { ...PROFILE, name: "" }],
    ["too-long name", { ...PROFILE, name: "A".repeat(256) }],
    ["missing constituency", { ...PROFILE, constituency: undefined }],
    ["invalid constituency", { ...PROFILE, name: "Narnia Ehdokas", constituency: "Narnian vaalipiiri" }],
    ["missing email", { ...PROFILE, email: undefined }],
    ["invalid email", { ...PROFILE, email: "bad-email" }],
    ["invalid photo URL", { ...PROFILE, photoUrl: "not-a-url" }],
    ["too-long bio", { ...PROFILE, bio: "A".repeat(1001) }],
  ]) {
    test(`${label} → 400`, async ({ request }) => {
      const { res } = await post(request, `/candidates/register/${party.registration_token}`, body);
      expect(res.status()).toBe(400);
    });
  }
});

test.describe("UC-CAND-PARTY: Party portal (party token)", () => {
  let party, candidate;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `PortalParty ${Date.now()}`);
  });

  test("overview (empty) includes the registration token", async ({ request }) => {
    const { res, body } = await get(request, `/candidates/party/${party.token}`);
    expect(res.status()).toBe(200);
    expect(body.party).toEqual({ id: party.id, name: party.name, registrationToken: party.registration_token });
    expect(body.candidates).toHaveLength(0);
  });

  test("overview lists candidates with progress but never their tokens", async ({ request }) => {
    candidate = await createCandidate(request, party, { name: "Portal Candidate", email: "portal@test.fi" });
    const { body } = await get(request, `/candidates/party/${party.token}`);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].answer_count).toBeDefined();
    expect(body.candidates[0].email).toBe("portal@test.fi");
    expect(body.candidates[0]).not.toHaveProperty("token");
  });

  test("party token can no longer create or edit candidates", async ({ request }) => {
    const create = await post(request, `/candidates/party/${party.token}`, PROFILE);
    expect(create.res.status()).toBe(404);
    const profile = await put(request, `/candidates/party/${party.token}/candidates/${candidate.id}`, PROFILE);
    expect(profile.res.status()).toBe(404);
    const answers = await put(request, `/candidates/party/${party.token}/candidates/${candidate.id}/answers`, { answers: {} });
    expect(answers.res.status()).toBe(404);
  });

  test("send-link to a candidate of another party → 404", async ({ request }) => {
    const other = await createParty(request, `OtherPortal ${Date.now()}`);
    const { res } = await post(request, `/candidates/party/${other.token}/candidates/${candidate.id}/send-link`, {});
    expect(res.status()).toBe(404);
  });

  test("remove a candidate of another party → 404", async ({ request }) => {
    const other = await createParty(request, `OtherRemove ${Date.now()}`);
    const { res } = await del(request, `/candidates/party/${other.token}/candidates/${candidate.id}`);
    expect(res.status()).toBe(404);
  });

  test("rotating the registration link invalidates the old one only", async ({ request }) => {
    const oldToken = party.registration_token;
    const { res, body } = await post(request, `/candidates/party/${party.token}/registration-token`, {});
    expect(res.status()).toBe(200);
    expect(body.registrationToken).not.toBe(oldToken);

    const old = await get(request, `/candidates/register/${oldToken}`);
    expect(old.res.status()).toBe(404);
    const fresh = await get(request, `/candidates/register/${body.registrationToken}`);
    expect(fresh.res.status()).toBe(200);
    // Existing candidates keep working.
    const me = await get(request, `/candidates/me/${candidate.token}`);
    expect(me.res.status()).toBe(200);
  });

  test("remove own candidate → gone, personal link stops working", async ({ request }) => {
    const { res } = await del(request, `/candidates/party/${party.token}/candidates/${candidate.id}`);
    expect(res.status()).toBe(200);
    const { res: pub } = await get(request, `/candidates/${candidate.id}`);
    expect(pub.status()).toBe(404);
    const { res: me } = await get(request, `/candidates/me/${candidate.token}`);
    expect(me.status()).toBe(404);
  });

  test("invalid party token returns 404", async ({ request }) => {
    const { res } = await get(request, "/candidates/party/nonexistent-token");
    expect(res.status()).toBe(404);
  });
});

test.describe("UC-CAND-3: Candidate edits own profile (candidate token)", () => {
  let party, candidate;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `UpdateParty ${Date.now()}`);
    candidate = await createCandidate(request, party, { name: "Original Name", email: "orig@test.fi" });
  });

  test("get own profile includes email and party", async ({ request }) => {
    const { res, body } = await get(request, `/candidates/me/${candidate.token}`);
    expect(res.status()).toBe(200);
    expect(body.name).toBe("Original Name");
    expect(body.email).toBe("orig@test.fi");
    expect(body.party).toEqual({ id: party.id, name: party.name });
  });

  test("update name, bio and email", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}`, {
      ...PROFILE,
      name: "Updated Name",
      bio: "New bio",
      email: "new@test.fi",
    });
    expect(res.status()).toBe(200);
    expect(body.name).toBe("Updated Name");
    expect(body.bio).toBe("New bio");
    expect(body.email).toBe("new@test.fi");
  });

  test("null photoUrl clears the field", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}`, { ...PROFILE, photoUrl: null });
    expect(res.status()).toBe(200);
    expect(body.photo_url).toBeNull();
  });

  test("too-long name returns 400", async ({ request }) => {
    const { res } = await put(request, `/candidates/me/${candidate.token}`, { ...PROFILE, name: "A".repeat(256) });
    expect(res.status()).toBe(400);
  });

  test("invalid candidate token returns 404", async ({ request }) => {
    const { res } = await put(request, "/candidates/me/nonexistent", PROFILE);
    expect(res.status()).toBe(404);
  });
});

test.describe("UC-CAND-4: Candidate saves own answers (candidate token)", () => {
  let party, candidate, questions;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `AnswerParty ${Date.now()}`);
    candidate = await createCandidate(request, party, { name: "Answer Candidate" });
    const qs = await submitQuestionSet(request, {
      ngoName: "AnswerNGO",
      title: `Answers ${Date.now()}`,
      questions: ["Väittämä 1", "Väittämä 2"],
    });
    await approveQuestionSet(request, qs.id);
    questions = qs.questions;
  });

  test("save answers (initial)", async ({ request }) => {
    const body = await saveAnswers(request, candidate, {
      [questions[0].id]: { value: 4, explanation: "Täysin samaa mieltä" },
      [questions[1].id]: { value: 1, explanation: "" },
    });
    expect(body.saved).toBe(2);
  });

  test("upsert answers (update existing)", async ({ request }) => {
    const body = await saveAnswers(request, candidate, {
      [questions[0].id]: { value: 0, explanation: "Changed my mind" },
    });
    expect(body.saved).toBe(1);

    // Verify via public endpoint
    const { body: full } = await get(request, `/candidates/${candidate.id}`);
    expect(full.answers[questions[0].id].value).toBe(0);
    expect(full.answers[questions[0].id].explanation).toBe("Changed my mind");
  });

  test("another candidate's token cannot write to this candidate", async ({ request }) => {
    const other = await createCandidate(request, party, { name: "Other Candidate" });
    await saveAnswers(request, other, { [questions[0].id]: { value: 4, explanation: "" } });

    const { body: full } = await get(request, `/candidates/${candidate.id}`);
    expect(full.answers[questions[0].id].value).toBe(0);
  });

  test("missing answers object returns 400", async ({ request }) => {
    const { res } = await put(request, `/candidates/me/${candidate.token}/answers`, {});
    expect(res.status()).toBe(400);
  });

  test("invalid answer value rejects the save and names the question", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}/answers`, {
      answers: { [questions[0].id]: { value: 99, explanation: "" }, [questions[1].id]: { value: 3, explanation: "" } },
    });
    expect(res.status()).toBe(400);
    expect(body.error).toContain(questions[0].statement);

    // Nothing was written: the earlier answers stand.
    const { body: full } = await get(request, `/candidates/${candidate.id}`);
    expect(full.answers[questions[0].id].value).toBe(0);
    expect(full.answers[questions[1].id].value).toBe(1);
  });

  test("too-long explanation rejects the save and names the question", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}/answers`, {
      answers: { [questions[0].id]: { value: 2, explanation: "A".repeat(501) } },
    });
    expect(res.status()).toBe(400);
    expect(body.error).toContain(questions[0].statement);

    const { body: full } = await get(request, `/candidates/${candidate.id}`);
    expect(full.answers[questions[0].id].explanation).toBe("Changed my mind");
  });

  test("invalid UUIDs, unknown questions and null answers are skipped", async ({ request }) => {
    const body = await saveAnswers(request, candidate, {
      "not-a-uuid": { value: 2, explanation: "" },
      "00000000-0000-0000-0000-000000000099": { value: 2, explanation: "" },
      [questions[1].id]: null,
    });
    expect(body.saved).toBe(0);
    expect(body.skipped).toEqual(["not-a-uuid", "00000000-0000-0000-0000-000000000099"]);
  });
});

// #17: the candidate page saves profile and answers in one request, all or nothing.
test.describe("Candidate saves profile and answers together (candidate token)", () => {
  let party, candidate, questions;
  const ownProfile = async (request) => (await get(request, `/candidates/me/${candidate.token}`)).body;

  test.beforeAll(async ({ request }) => {
    party = await createParty(request, `CombinedParty ${Date.now()}`);
    candidate = await createCandidate(request, party, { name: "Combined Candidate", bio: "Alkuperäinen" });
    const qs = await submitQuestionSet(request, {
      ngoName: "CombinedNGO",
      title: `Combined ${Date.now()}`,
      questions: ["Yhdistetty 1", "Yhdistetty 2"],
    });
    await approveQuestionSet(request, qs.id);
    questions = qs.questions;
    await saveAnswers(request, candidate, { [questions[0].id]: { value: 1, explanation: "" } });
  });

  const profile = () => ({ ...PROFILE, name: candidate.name, email: candidate.email });

  test("an invalid answer leaves the profile unchanged", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}`, {
      ...profile(),
      bio: "Muutettu",
      answers: { [questions[0].id]: { value: 3, explanation: "" }, [questions[1].id]: { value: 99, explanation: "" } },
    });
    expect(res.status()).toBe(400);
    expect(body.error).toContain(questions[1].statement);

    const me = await ownProfile(request);
    expect(me.bio).toBe("Alkuperäinen");
    expect(me.answers[questions[0].id].value).toBe(1);
    expect(me.answers[questions[1].id]).toBeUndefined();
  });

  test("an invalid constituency leaves the answers unchanged", async ({ request }) => {
    const { res } = await put(request, `/candidates/me/${candidate.token}`, {
      ...profile(),
      constituency: "Atlantis",
      answers: { [questions[0].id]: { value: 4, explanation: "" } },
    });
    expect(res.status()).toBe(400);

    const me = await ownProfile(request);
    expect(me.constituency).toBe("Helsingin vaalipiiri");
    expect(me.answers[questions[0].id].value).toBe(1);
  });

  test("a valid save stores both", async ({ request }) => {
    const { res, body } = await put(request, `/candidates/me/${candidate.token}`, {
      ...profile(),
      bio: "Muutettu",
      answers: { [questions[0].id]: { value: 3, explanation: "Perustelu" }, [questions[1].id]: { value: 0, explanation: "" } },
    });
    expect(res.status()).toBe(200);
    expect(body).toMatchObject({ bio: "Muutettu", saved: 2, skipped: [] });

    const me = await ownProfile(request);
    expect(me.bio).toBe("Muutettu");
    expect(me.answers[questions[0].id]).toMatchObject({ value: 3, explanation: "Perustelu" });
    expect(me.answers[questions[1].id].value).toBe(0);
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
    const candidate = await createCandidate(request, party, {
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
