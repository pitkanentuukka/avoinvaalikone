jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const email = require("../../src/email");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const SET = "550e8400-e29b-41d4-a716-446655440000";
const A = "aa000000-0000-0000-0000-000000000001";
const B = "bb000000-0000-0000-0000-000000000002";
const C = "cc000000-0000-0000-0000-000000000003";
const set = { id: SET, ngo_name: "Järjestö", status: "pending" };

beforeEach(() => {
  process.env.ADMIN_SECRET = "test-admin-secret";
  resetDbMocks();
  for (const fn of Object.values(email)) fn.mockReset().mockResolvedValue();
});

// Model the rows used by validation, without coupling results to query order.
// No mutations are simulated: invalid requests must stop before issuing any.
function setup({ existing = [A, B, C], linked = [A, B] } = {}) {
  const client = buildMockClient();
  client.query.mockImplementation(async (sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return {};
    if (/SELECT \* FROM question_sets/.test(sql)) return { rows: [set] };
    if (/SELECT id FROM questions/.test(sql)) {
      return { rows: existing.filter((id) => params[0].includes(id)).map((id) => ({ id })) };
    }
    if (/SELECT/.test(sql) && /question_set_questions/.test(sql)) {
      return { rows: linked.map((id) => ({ id, question_id: id, statement: "Väittämä" })) };
    }
    if (/UPDATE question_sets/.test(sql)) return { rows: [{ ...set, status: "approved" }] };
    return { rows: [] };
  });
  return client;
}

function review(reviews) {
  return request(app).patch(`/api/admin/question-sets/${SET}/review`)
    .set("Authorization", "Bearer test-admin-secret").send({ reviews });
}

function expectNoWrites(client) {
  expect(client.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([]);
  expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  expect(email.sendQuestionSetPartialReviewNotification).not.toHaveBeenCalled();
}

test("case-variant self-merge returns 400 before a pool checkout", async () => {
  const client = setup();
  const res = await review([{ questionId: A, duplicateOf: A.toUpperCase() }]);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/itseensä/);
  expect(db.getClient).not.toHaveBeenCalled();
  expectNoWrites(client);
});

test("missing merge target returns 404 and rolls back before any change", async () => {
  const client = setup({ existing: [A, B] });
  const res = await review([{ questionId: B, editedStatement: "Muutos" }, { questionId: A, duplicateOf: C }]);
  expect(res.status).toBe(404);
  expectNoWrites(client);
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledTimes(1);
});

test.each([
  ["mutual duplicates", [{ questionId: A, duplicateOf: B }, { questionId: B, duplicateOf: A }]],
  ["merge chain", [{ questionId: A, duplicateOf: B.toUpperCase() }, { questionId: B, duplicateOf: C }]],
  ["repeated source", [{ questionId: A, duplicateOf: B }, { questionId: A.toUpperCase(), duplicateOf: C }]],
])("%s returns 400 before any change", async (_name, reviews) => {
  const client = setup();
  const res = await review(reviews);
  expect(res.status).toBe(400);
  expectNoWrites(client);
});

test.each([
  ["merge", { duplicateOf: B }],
  ["edit", { editedStatement: "Muutos" }],
  ["rejection", { rejected: true }],
  ["acceptance", {}],
])("a source outside the set: %s returns 404 before any change", async (_name, action) => {
  const client = setup({ linked: [B] });
  const res = await review([{ questionId: B, editedStatement: "Muutos" }, { questionId: A, ...action }]);
  expect(res.status).toBe(404);
  expectNoWrites(client);
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
});

test("a missing source returns 404 before any change", async () => {
  const client = setup({ existing: [B, C], linked: [B] });
  const res = await review([{ questionId: A, duplicateOf: C }]);
  expect(res.status).toBe(404);
  expectNoWrites(client);
});

test("two uppercase sources can merge into the same existing target outside the set", async () => {
  const client = setup();
  const res = await review([
    { questionId: A.toUpperCase(), duplicateOf: C.toUpperCase() },
    { questionId: B.toUpperCase(), duplicateOf: C },
  ]);
  expect(res.status).toBe(200);
  expect(client.query.mock.calls.filter(([sql]) => /^DELETE FROM questions WHERE/.test(sql)))
    .toEqual([["DELETE FROM questions WHERE id = $1", [A]], ["DELETE FROM questions WHERE id = $1", [B]]]);
  const copies = client.query.mock.calls.filter(([sql]) => /INSERT INTO candidate_answers/.test(sql));
  expect(copies.map(([, params]) => params)).toEqual([[C, A], [C, B]]);
  expect(client.query).toHaveBeenCalledWith("COMMIT");
});
