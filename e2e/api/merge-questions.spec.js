// @ts-check
const { test, expect } = require("@playwright/test");
const {
  get,
  createParty,
  submitQuestionSet,
  approveQuestionSet,
  createCandidate,
  saveAnswers,
  voterMatch,
  mergeQuestions,
} = require("../helpers");

test.describe("UC-MERGE: many-to-many question deduplication", () => {
  test("merging a duplicate links the canonical question to both NGOs' sets", async ({ request }) => {
    const ts = Date.now();
    const setA = await submitQuestionSet(request, {
      ngoName: "Yhdistä-A",
      title: `A ${ts}`,
      questions: ["Yhteinen väite", "Vain A:ssa"],
    });
    await approveQuestionSet(request, setA.id);
    const setB = await submitQuestionSet(request, {
      ngoName: "Yhdistä-B",
      title: `B ${ts}`,
      questions: ["Yhteinen väite (kaksoiskappale)", "Vain B:ssä"],
    });
    await approveQuestionSet(request, setB.id);

    const keepId = setA.questions[0].id;
    const dropId = setB.questions[0].id;

    const { res, body } = await mergeQuestions(request, keepId, [dropId]);
    expect(res.status()).toBe(200);
    expect(body.merged).toBe(1);

    const { body: sets } = await get(request, "/question-sets");
    const a = sets.find((s) => s.id === setA.id);
    const b = sets.find((s) => s.id === setB.id);

    // Both sets now reference the kept canonical question; the duplicate is gone.
    expect(a.questions.map((q) => q.id)).toContain(keepId);
    expect(b.questions.map((q) => q.id)).toContain(keepId);
    expect(b.questions.map((q) => q.id)).not.toContain(dropId);
    // B still has its own non-duplicate question.
    expect(b.questions).toHaveLength(2);
  });

  test("voter who selects only one NGO still matches on a merged shared question", async ({ request }) => {
    const ts = Date.now();
    const party = await createParty(request, `Yhdistä-puolue ${ts}`, "p@test.fi");
    const setA = await submitQuestionSet(request, {
      ngoName: "A", title: `A ${ts}`, questions: ["Jaettu väite"],
    });
    await approveQuestionSet(request, setA.id);
    const setB = await submitQuestionSet(request, {
      ngoName: "B", title: `B ${ts}`, questions: ["Jaettu väite (dup)"],
    });
    await approveQuestionSet(request, setB.id);

    const keepId = setA.questions[0].id;
    const dropId = setB.questions[0].id;

    const candidate = await createCandidate(request, party.token, { name: "Ehdokas", email: "c@test.fi" });
    // Candidate answered the canonical (set A) question only.
    await saveAnswers(request, party.token, candidate.id, { [keepId]: { value: 4, explanation: "" } });

    await mergeQuestions(request, keepId, [dropId]);

    // Voter picks ONLY set B and answers the (now canonical) question.
    const match = await voterMatch(request, {
      answers: { [keepId]: 4 },
      questionSetIds: [setB.id],
    });
    const me = match.results.find((r) => r.id === candidate.id);
    expect(me).toBeTruthy();
    expect(me.match).toBe(100);
    expect(me.answeredCount).toBe(1);
  });

  test("on conflicting candidate answers the later one wins after merge", async ({ request }) => {
    const ts = Date.now();
    const party = await createParty(request, `Yhdistä-konflikti ${ts}`, "p@test.fi");
    const setA = await submitQuestionSet(request, {
      ngoName: "A", title: `A ${ts}`, questions: ["Väite"],
    });
    await approveQuestionSet(request, setA.id);
    const setB = await submitQuestionSet(request, {
      ngoName: "B", title: `B ${ts}`, questions: ["Väite (dup)"],
    });
    await approveQuestionSet(request, setB.id);

    const keepId = setA.questions[0].id;
    const dropId = setB.questions[0].id;
    const candidate = await createCandidate(request, party.token, { name: "Ehdokas", email: "c@test.fi" });

    // Answer the kept question first, then the duplicate later with a different value.
    await saveAnswers(request, party.token, candidate.id, { [keepId]: { value: 0, explanation: "vanha" } });
    await saveAnswers(request, party.token, candidate.id, { [dropId]: { value: 4, explanation: "uusi" } });

    await mergeQuestions(request, keepId, [dropId]);

    const { body: profile } = await get(request, `/candidates/${candidate.id}`);
    expect(profile.answers[keepId].value).toBe(4);
    expect(profile.answers[keepId].explanation).toBe("uusi");
    expect(profile.answers[dropId]).toBeUndefined();
  });

  test("merge validation: cannot merge a question into itself", async ({ request }) => {
    const ts = Date.now();
    const setA = await submitQuestionSet(request, {
      ngoName: "A", title: `A ${ts}`, questions: ["Väite"],
    });
    await approveQuestionSet(request, setA.id);
    const id = setA.questions[0].id;
    const { res } = await mergeQuestions(request, id, [id]);
    expect(res.status()).toBe(400);
  });
});
