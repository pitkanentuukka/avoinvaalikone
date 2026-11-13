// Loaded with import() like apiClient.test.js: the frontend is an ES module package.
let answeredCount, distinctQuestions;
beforeAll(async () => {
  ({ answeredCount, distinctQuestions } = await import("../../vaalikone-frontend/src/questions.js"));
});

const set = (id, status, ids) => ({ id, status, questions: ids.map((q) => ({ id: q })) });

describe("distinctQuestions", () => {
  test("lists questions in approved sets once, skipping other sets", () => {
    const sets = [
      set("a", "approved", ["q1", "q2"]),
      set("b", "approved", ["q2", "q3"]),
      set("c", "pending", ["q4"]),
      set("d", "rejected", ["q5"]),
    ];
    expect(distinctQuestions(sets).map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
  });
});

describe("answeredCount", () => {
  test("counts rated questions", () => {
    const questions = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];
    const answers = { q1: { value: 0 }, q2: { value: 4 } };
    expect(answeredCount(answers, questions)).toBe(2);
  });

  test("does not count an explanation without a rating", () => {
    const questions = [{ id: "q1" }, { id: "q2" }];
    const answers = { q1: { value: 2 }, q2: { text: "perustelu" } };
    expect(answeredCount(answers, questions)).toBe(1);
  });

  // #19: answers loaded from the server for questions not on the page were
  // counted, showing e.g. "5 / 4". The public question list already leaves out
  // hidden and unapproved sets, so such a question is usually just absent.
  test("ignores answers to questions missing from the question list", () => {
    const questions = [{ id: "q1" }, { id: "q2" }];
    const answers = { q1: { value: 1 }, q2: { value: 2 }, gone: { value: 3 } };
    expect(answeredCount(answers, questions)).toBe(2);
  });

  test("ignores answers to questions in sets that are not approved", () => {
    const sets = [set("a", "approved", ["q1", "q2", "q3", "q4"]), set("b", "pending", ["q5"])];
    const questions = distinctQuestions(sets);
    const answers = { q1: { value: 1 }, q2: { value: 2 }, q3: { value: 3 }, q4: { value: 4 }, q5: { value: 0 } };
    expect(answeredCount(answers, questions)).toBe(questions.length);
  });
});
