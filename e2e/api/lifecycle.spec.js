// @ts-check
const { test, expect } = require("@playwright/test");
const {
  adminHeaders,
  get,
  del,
  patch,
  createParty,
  submitQuestionSet,
  approveQuestionSet,
  createCandidate,
  saveAnswers,
  voterMatch,
} = require("../helpers");

test.describe("E2E-1: Full lifecycle", () => {
  test("from party creation to voter match", async ({ request }) => {
    // 1. Admin creates a party
    const party = await createParty(request, `Lifecycle ${Date.now()}`);
    expect(party.token).toBeTruthy();

    // 2. NGO submits a question set
    const qs = await submitQuestionSet(request, {
      ngoName: "Lifecycle NGO",
      title: "Lifecycle Questions",
      questions: [
        "Verotusta tulee keventää",
        "Maahanmuuttoa tulee lisätä",
      ],
    });
    expect(qs.status).toBe("pending");

    // 3. Admin approves
    const approved = await approveQuestionSet(request, qs.id);
    expect(approved.status).toBe("approved");

    // 4. Candidate registers
    const candidate = await createCandidate(request, party.token, {
      name: "Lifecycle Candidate",
      email: "lifecycle@test.fi",
    });
    expect(candidate.id).toBeTruthy();

    // 5. Candidate answers questions
    const answers = {};
    qs.questions.forEach((q, i) => {
      answers[q.id] = { value: i === 0 ? 4 : 1, explanation: `Perustelu ${i + 1}` };
    });
    const saved = await saveAnswers(request, party.token, candidate.id, answers);
    expect(saved.saved).toBe(2);

    // 6. Voter views approved question sets
    const { body: publicSets } = await get(request, "/question-sets");
    expect(publicSets.find((s) => s.id === qs.id)).toBeDefined();

    // 7. Voter matches
    const voterAnswers = {};
    qs.questions.forEach((q) => {
      voterAnswers[q.id] = 4;
    });
    const matchResult = await voterMatch(request, { answers: voterAnswers });
    expect(matchResult.sessionId).toBeTruthy();
    expect(matchResult.results.length).toBeGreaterThan(0);

    const matchedCandidate = matchResult.results.find((r) => r.id === candidate.id);
    expect(matchedCandidate).toBeDefined();
    expect(matchedCandidate.match).toBeGreaterThan(0);

    // 8. Voter views candidate profile
    const { body: profile } = await get(request, `/candidates/${candidate.id}`);
    expect(profile.name).toBe("Lifecycle Candidate");
    expect(Object.keys(profile.answers)).toHaveLength(2);
    expect(profile.answers[qs.questions[0].id].explanation).toBe("Perustelu 1");
  });
});

test.describe("E2E-2: Multiple parties and candidates", () => {
  test("voter matches against candidates from multiple parties", async ({ request }) => {
    const ts = Date.now();

    // Create question set
    const qs = await submitQuestionSet(request, {
      ngoName: "MultiNGO",
      title: `Multi ${ts}`,
      questions: ["Kysymys 1", "Kysymys 2"],
    });
    await approveQuestionSet(request, qs.id);

    // Create two parties with one candidate each
    const partyA = await createParty(request, `PartyA ${ts}`);
    const partyB = await createParty(request, `PartyB ${ts}`);

    const candA = await createCandidate(request, partyA.token, { name: "Candidate A" });
    const candB = await createCandidate(request, partyB.token, { name: "Candidate B" });

    // Candidate A answers [4, 4], Candidate B answers [0, 0]
    const answersA = {};
    const answersB = {};
    qs.questions.forEach((q) => {
      answersA[q.id] = { value: 4, explanation: "" };
      answersB[q.id] = { value: 0, explanation: "" };
    });
    await saveAnswers(request, partyA.token, candA.id, answersA);
    await saveAnswers(request, partyB.token, candB.id, answersB);

    // Voter answers all 4 — should match A better than B
    const voterAnswers = {};
    qs.questions.forEach((q) => {
      voterAnswers[q.id] = 4;
    });

    const result = await voterMatch(request, { answers: voterAnswers });
    const matchA = result.results.find((r) => r.id === candA.id);
    const matchB = result.results.find((r) => r.id === candB.id);

    expect(matchA.match).toBe(100);
    expect(matchB.match).toBe(0);
    // A should come before B in results
    const idxA = result.results.findIndex((r) => r.id === candA.id);
    const idxB = result.results.findIndex((r) => r.id === candB.id);
    expect(idxA).toBeLessThan(idxB);
  });
});

test.describe("E2E-3: Question set rejection flow", () => {
  test("rejected set not visible, resubmit and approve works", async ({ request }) => {
    const ts = Date.now();

    // Submit and reject
    const rejected = await submitQuestionSet(request, {
      ngoName: "RejFlow NGO",
      title: `Rejected ${ts}`,
      questions: ["Bad question"],
    });
    await patch(
      request,
      `/admin/question-sets/${rejected.id}/reject`,
      adminHeaders()
    );

    // Not visible publicly
    let { body: sets } = await get(request, "/question-sets");
    expect(sets.find((s) => s.id === rejected.id)).toBeUndefined();

    // Resubmit corrected version
    const corrected = await submitQuestionSet(request, {
      ngoName: "RejFlow NGO",
      title: `Corrected ${ts}`,
      questions: ["Good question"],
    });
    await approveQuestionSet(request, corrected.id);

    // Now visible
    ({ body: sets } = await get(request, "/question-sets"));
    expect(sets.find((s) => s.id === corrected.id)).toBeDefined();
  });
});

test.describe("E2E-4: Candidate answer update flow", () => {
  test("updated answers reflect in voter match", async ({ request }) => {
    const ts = Date.now();
    const party = await createParty(request, `Update ${ts}`);
    const qs = await submitQuestionSet(request, {
      ngoName: "UpdateNGO",
      title: `Update ${ts}`,
      questions: ["Q1"],
    });
    await approveQuestionSet(request, qs.id);
    const candidate = await createCandidate(request, party.token, { name: "Updater" });

    // Initial answer: value 0
    const initial = {};
    initial[qs.questions[0].id] = { value: 0, explanation: "" };
    await saveAnswers(request, party.token, candidate.id, initial);

    // Voter answers 4 — should get 0% match
    const voterAnswers = { [qs.questions[0].id]: 4 };
    let result = await voterMatch(request, { answers: voterAnswers });
    let match = result.results.find((r) => r.id === candidate.id);
    expect(match.match).toBe(0);

    // Update answer to value 4
    const updated = {};
    updated[qs.questions[0].id] = { value: 4, explanation: "Changed" };
    await saveAnswers(request, party.token, candidate.id, updated);

    // Now should get 100% match
    result = await voterMatch(request, { answers: voterAnswers });
    match = result.results.find((r) => r.id === candidate.id);
    expect(match.match).toBe(100);
  });
});

test.describe("E2E-5: Party deletion cascade", () => {
  test("deleting party removes candidates from match results", async ({ request }) => {
    const ts = Date.now();
    const party = await createParty(request, `Cascade ${ts}`);
    const qs = await submitQuestionSet(request, {
      ngoName: "CascadeNGO",
      title: `Cascade ${ts}`,
      questions: ["CascadeQ"],
    });
    await approveQuestionSet(request, qs.id);
    const candidate = await createCandidate(request, party.token, { name: "Cascade Cand" });
    const answers = {};
    answers[qs.questions[0].id] = { value: 2, explanation: "" };
    await saveAnswers(request, party.token, candidate.id, answers);

    // Verify candidate appears in match
    let result = await voterMatch(request, {
      answers: { [qs.questions[0].id]: 2 },
    });
    expect(result.results.find((r) => r.id === candidate.id)).toBeDefined();

    // Delete party
    await del(request, `/admin/parties/${party.id}`, adminHeaders());

    // Candidate should be gone
    result = await voterMatch(request, {
      answers: { [qs.questions[0].id]: 2 },
    });
    // When no candidates overlap, backend returns [] directly instead of { results: [] }
    const results = result.results || result;
    expect(results.find((r) => r.id === candidate.id)).toBeUndefined();

    // Candidate profile should 404
    const { res } = await get(request, `/candidates/${candidate.id}`);
    expect(res.status()).toBe(404);
  });
});

test.describe("E2E-6: Weight impact on match results", () => {
  test("high weight on matching question changes ranking", async ({ request }) => {
    const ts = Date.now();
    const qs = await submitQuestionSet(request, {
      ngoName: "WeightNGO",
      title: `Weight ${ts}`,
      questions: ["W1", "W2"],
    });
    await approveQuestionSet(request, qs.id);

    const partyA = await createParty(request, `WeightA ${ts}`);
    const partyB = await createParty(request, `WeightB ${ts}`);
    const candA = await createCandidate(request, partyA.token, { name: "Weight A" });
    const candB = await createCandidate(request, partyB.token, { name: "Weight B" });

    // Candidate A: [4, 0], Candidate B: [0, 4]
    const aAnswers = {};
    aAnswers[qs.questions[0].id] = { value: 4, explanation: "" };
    aAnswers[qs.questions[1].id] = { value: 0, explanation: "" };
    await saveAnswers(request, partyA.token, candA.id, aAnswers);

    const bAnswers = {};
    bAnswers[qs.questions[0].id] = { value: 0, explanation: "" };
    bAnswers[qs.questions[1].id] = { value: 4, explanation: "" };
    await saveAnswers(request, partyB.token, candB.id, bAnswers);

    // Voter answers [4, 4] with default weights — both should be 50%
    const voterAnswers = {};
    qs.questions.forEach((q) => {
      voterAnswers[q.id] = 4;
    });

    let result = await voterMatch(request, { answers: voterAnswers });
    let matchA = result.results.find((r) => r.id === candA.id);
    let matchB = result.results.find((r) => r.id === candB.id);
    expect(matchA.match).toBe(matchB.match); // Both 50%

    // Now give high weight to Q1 — Candidate A (who answered 4 on Q1) should rank higher
    const weights = { [qs.questions[0].id]: 3 };
    result = await voterMatch(request, { answers: voterAnswers, weights });
    matchA = result.results.find((r) => r.id === candA.id);
    matchB = result.results.find((r) => r.id === candB.id);
    expect(matchA.match).toBeGreaterThan(matchB.match);
  });
});
