let reconcileAnswers;
beforeAll(async () => {
  ({ reconcileAnswers } = await import("../../vaalikone-frontend/src/candidateAnswers.js"));
});

const answer = (value, text = "") => ({ value, text });
const profile = (answers) => ({
  answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { value: a.value, explanation: a.text }])),
});

test.each([
  ["position", answer(4, "old")],
  ["explanation", answer(2, "new explanation")],
  ["cleared explanation", answer(2, "")],
])("preserves a %s edited while the save or refetch is pending (#104)", (_, edited) => {
  const sent = { gone: answer(1), kept: answer(2, "old") };
  const current = { ...sent, kept: edited };
  expect(reconcileAnswers(profile({ kept: sent.kept }), sent, current, ["gone"]))
    .toEqual({ kept: edited });
});

test("keeps a newly rated answer while accepting a merge-carried server answer", () => {
  const sent = { gone: answer(1) };
  const current = { ...sent, new: answer(0, "new answer") };
  const me = profile({ merged: answer(3, "carried over") });
  expect(reconcileAnswers(me, sent, current, ["gone"]))
    .toEqual({ new: current.new, merged: answer(3, "carried over") });
});

test("drops skipped answers even if edited during the save", () => {
  const sent = { gone: answer(1), kept: answer(2) };
  const current = { ...sent, gone: answer(4) };
  expect(reconcileAnswers(profile({ kept: answer(2) }), sent, current, ["gone"]))
    .toEqual({ kept: answer(2) });
});

test("refreshes unchanged entries from the server without mutating the snapshot", () => {
  const sent = Object.freeze({ kept: Object.freeze(answer(2)) });
  const current = { kept: answer(2) };
  expect(reconcileAnswers(profile({ kept: answer(3, "server") }), sent, current, []))
    .toEqual({ kept: answer(3, "server") });
  expect(sent).toEqual({ kept: answer(2) });
  expect(current).toEqual({ kept: answer(2) });
});
