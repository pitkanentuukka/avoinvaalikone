jest.mock("../../src/db/pool");

const router = require("../../src/routes/voter");
const match = router.stack.find(layer => layer.route?.path === "/match").route.stack[0].handle;
const db = require("../../src/db/pool");

const Q1 = "550e8400-e29b-41d4-a716-446655440000";
const Q2 = "660e8400-e29b-41d4-a716-446655440000";
const SESSION = "770e8400-e29b-41d4-a716-446655440000";
const fkError = () => Object.assign(new Error("question deleted"), { code: "23503" });
const flush = () => new Promise(setImmediate);
const inserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO voter_responses/.test(sql));

beforeEach(() => {
  db.query.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function setup(researchError) {
  db.query.mockResolvedValueOnce({ rows: [{ id: Q1, in_selected_sets: true }, { id: Q2, in_selected_sets: true }] });
  db.query.mockResolvedValueOnce({ rows: [] }); // no candidate answers
  db.query.mockRejectedValueOnce(researchError);
}

async function submit(extra = {}) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await match({ body: {
    answers: { [Q2]: 4, [Q1]: 2 }, weights: { [Q2]: 0 }, sessionId: SESSION, ...extra,
  } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  return { status: 200, body: res.json.mock.calls[0][0] };
}

test.each([undefined, [SESSION]])("question lookup locks FK targets in admin id order (sets %p)", async (questionSetIds) => {
  db.query.mockResolvedValueOnce({ rows: [{ id: Q1, in_selected_sets: true }, { id: Q2, in_selected_sets: true }] });
  db.query.mockResolvedValue({ rows: [] });
  const res = await submit({ questionSetIds });
  expect(res.status).toBe(200);
  expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY (?:q\.)?id\b/i);
  expect(inserts()[0][1]).toEqual([SESSION, Q1, 2, 1, Q2, 4, 0]);
});

test("FK race rechecks scored questions and retries surviving answers with the same session", async () => {
  setup(fkError());
  db.query.mockResolvedValueOnce({ rows: [{ id: Q2 }] });
  db.query.mockResolvedValueOnce({ rows: [] });
  const res = await submit();
  await flush();
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ sessionId: SESSION, questionCount: 2, results: [] });
  expect(db.query.mock.calls[3][0]).toMatch(/SELECT id FROM questions[\s\S]*ORDER BY id/i);
  expect(db.query.mock.calls[3][1]).toEqual([[Q1, Q2]]);
  expect(inserts()).toHaveLength(2);
  expect(inserts()[1][1]).toEqual([SESSION, Q2, 4, 0]);
  expect(inserts()[1][0]).toMatch(/ON CONFLICT DO NOTHING/);
  expect(console.error).not.toHaveBeenCalled();
});

test("all questions deleted during the race needs no second insert", async () => {
  setup(fkError());
  db.query.mockResolvedValueOnce({ rows: [] });
  expect((await submit()).status).toBe(200);
  await flush();
  expect(db.query).toHaveBeenCalledTimes(4);
  expect(inserts()).toHaveLength(1);
  expect(console.error).not.toHaveBeenCalled();
});

test.each(["retry lookup", "retry insert"])("failure in %s is logged and retry is bounded", async (stage) => {
  setup(fkError());
  if (stage === "retry insert") db.query.mockResolvedValueOnce({ rows: [{ id: Q2 }] });
  db.query.mockRejectedValueOnce(fkError());
  expect((await submit()).status).toBe(200);
  await flush();
  expect(db.query).toHaveBeenCalledTimes(stage === "retry insert" ? 5 : 4);
  expect(console.error).toHaveBeenCalledWith("voter_responses insert failed:", "question deleted");
});

test("non-FK insert errors are logged without retry", async () => {
  setup(Object.assign(new Error("connection lost"), { code: "08006" }));
  expect((await submit()).status).toBe(200);
  await flush();
  expect(db.query).toHaveBeenCalledTimes(3);
  expect(console.error).toHaveBeenCalledWith("voter_responses insert failed:", "connection lost");
});

test("match response does not wait for research retry", async () => {
  setup(fkError());
  let finishLookup;
  db.query.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve; }));
  const res = await submit();
  expect(res.status).toBe(200);
  expect(finishLookup).toBeDefined();
  finishLookup({ rows: [] });
  await flush();
});
