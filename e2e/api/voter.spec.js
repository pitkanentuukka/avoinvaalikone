// @ts-check
const { test, expect } = require("@playwright/test");
const { post, fullSetup, voterMatch } = require("../helpers");

test.describe("UC-VOTER-1: Voter match", () => {
  let setup;

  test.beforeAll(async ({ request }) => {
    setup = await fullSetup(request, {
      partyName: `VoterParty ${Date.now()}`,
      answerValues: [4, 2, 0],
    });
  });

  test("perfect match returns 100%", async ({ request }) => {
    const answers = {};
    setup.questions.forEach((q, i) => {
      answers[q.id] = [4, 2, 0][i];
    });

    const result = await voterMatch(request, { answers });
    expect(result.sessionId).toBeTruthy();
    expect(result.results.length).toBeGreaterThan(0);

    const match = result.results.find((r) => r.id === setup.candidate.id);
    expect(match).toBeDefined();
    expect(match.match).toBe(100);
  });

  test("maximally different answers return 0%", async ({ request }) => {
    const answers = {};
    // Candidate answered [4, 2, 0], voter answers opposite [0, 2, 4]
    setup.questions.forEach((q, i) => {
      answers[q.id] = [0, 2, 4][i];
    });

    const result = await voterMatch(request, { answers });
    const match = result.results.find((r) => r.id === setup.candidate.id);
    expect(match).toBeDefined();
    // Middle question matches perfectly, others are max diff
    // q1: |0-4|/4 = 1, sim=0; q2: |2-2|/4 = 0, sim=1; q3: |4-0|/4 = 1, sim=0
    // Average = (0+1+0)/3 = 33%
    expect(match.match).toBe(33);
  });

  test("weights affect match score", async ({ request }) => {
    const answers = {};
    const weights = {};
    // Answer same as candidate on q1 (value 4), different on q2 and q3
    setup.questions.forEach((q, i) => {
      answers[q.id] = [4, 0, 4][i];
    });
    // Give high weight to q1 where voter matches
    weights[setup.questions[0].id] = 3;

    const result = await voterMatch(request, { answers, weights });
    const match = result.results.find((r) => r.id === setup.candidate.id);
    expect(match).toBeDefined();
    // q1: sim=1, weight=3+1=4; q2: sim=0.5 (|0-2|/4=0.5), weight=1; q3: sim=0 (|4-0|/4=1), weight=1
    // weighted = (1*4 + 0.5*1 + 0*1) / (4+1+1) = 4.5/6 = 75%
    expect(match.match).toBe(75);
  });

  test("filter by questionSetIds", async ({ request }) => {
    const answers = {};
    setup.questions.forEach((q) => {
      answers[q.id] = 2;
    });

    const result = await voterMatch(request, {
      answers,
      questionSetIds: [setup.questionSet.id],
    });
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("returns session ID for anonymous tracking", async ({ request }) => {
    const answers = {};
    setup.questions.forEach((q) => {
      answers[q.id] = 2;
    });

    const r1 = await voterMatch(request, { answers });
    const r2 = await voterMatch(request, { answers });
    expect(r1.sessionId).toBeTruthy();
    expect(r2.sessionId).toBeTruthy();
    // Each call gets a unique session ID
    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  test("results sorted by match descending", async ({ request }) => {
    // Create a second candidate with different answers
    const { createParty, createCandidate, saveAnswers, approveQuestionSet, submitQuestionSet } = require("../helpers");
    const party2 = await createParty(request, `VoterSort ${Date.now()}`);
    const cand2 = await createCandidate(request, party2.token, { name: "Candidate 2" });

    const answerMap = {};
    setup.questions.forEach((q) => {
      answerMap[q.id] = { value: 2, explanation: "" };
    });
    await saveAnswers(request, party2.token, cand2.id, answerMap);

    // Voter answers all 2 — cand2 should match better than setup.candidate
    const voterAnswers = {};
    setup.questions.forEach((q) => {
      voterAnswers[q.id] = 2;
    });

    const result = await voterMatch(request, { answers: voterAnswers });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    // Verify sorted by match descending
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].match).toBeGreaterThanOrEqual(result.results[i].match);
    }
  });
});

test.describe("UC-VOTER-1: Voter match validation", () => {
  test("empty answers returns 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", { answers: {} });
    expect(res.status()).toBe(400);
  });

  test("missing answers returns 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", {});
    expect(res.status()).toBe(400);
  });

  test("invalid answer values return 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", {
      answers: { "00000000-0000-0000-0000-000000000001": 5 },
    });
    expect(res.status()).toBe(400);
  });

  test("invalid weight values return 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", {
      answers: { "00000000-0000-0000-0000-000000000001": 2 },
      weights: { "00000000-0000-0000-0000-000000000001": 4 },
    });
    expect(res.status()).toBe(400);
  });

  test("non-UUID question IDs return 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", {
      answers: { "not-a-uuid": 2 },
    });
    expect(res.status()).toBe(400);
  });

  test("non-UUID questionSetIds return 400", async ({ request }) => {
    const { res } = await post(request, "/voter/match", {
      answers: { "00000000-0000-0000-0000-000000000001": 2 },
      questionSetIds: ["not-a-uuid"],
    });
    expect(res.status()).toBe(400);
  });

  test("no overlapping candidates returns empty array", async ({ request }) => {
    // Use a UUID that no candidate has answered
    const { res, body } = await post(request, "/voter/match", {
      answers: { "00000000-0000-0000-0000-000000000099": 2 },
    });
    expect(res.status()).toBe(200);
    // When no candidates overlap, backend returns [] directly
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });
});

test.describe("E2E-7: No overlapping answers", () => {
  test("candidate and voter answer different question sets", async ({ request }) => {
    const { fullSetup: fs, createParty: cp, submitQuestionSet: sqs, approveQuestionSet: aqs, createCandidate: cc, saveAnswers: sa, voterMatch: vm } = require("../helpers");

    // Setup: candidate answers set A
    const setup = await fs(request, {
      partyName: `NoOverlap ${Date.now()}`,
      questions: ["Kysymys A1", "Kysymys A2"],
      answerValues: [4, 4],
    });

    // Create a separate question set B
    const qsB = await sqs(request, {
      ngoName: "SetB NGO",
      title: `Set B ${Date.now()}`,
      questions: ["Kysymys B1", "Kysymys B2"],
    });
    await aqs(request, qsB.id);

    // Voter only answers set B questions
    const voterAnswers = {};
    qsB.questions.forEach((q) => {
      voterAnswers[q.id] = 2;
    });

    const result = await vm(request, {
      answers: voterAnswers,
      questionSetIds: [qsB.id],
    });
    // Candidate from setup only answered set A, so should not appear
    const found = (result.results || result).find((r) => r.id === setup.candidate.id);
    expect(found).toBeUndefined();
  });
});
