jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const { adminRouter } = require("../../src/routes/questionSets");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");
const SET_ID = "550e8400-e29b-41d4-a716-446655440000";
const Q1 = "660e8400-e29b-41d4-a716-446655440000";
const Q2 = "770e8400-e29b-41d4-a716-446655440000";
const route = adminRouter.stack.find(layer => layer.route?.path === "/:id" && layer.route.methods.delete).route;
const handle = route.stack.at(-1).handle;

beforeEach(resetDbMocks);

// Model READ COMMITTED's fresh snapshots: Q2 still has another link during
// SELECT FOR UPDATE, but the other unlink commits before DELETE. Q2 must not
// be deleted by this transaction, since it never locked Q2 in id order (#91).
test.each([[[Q1]], [[]]])("cleanup deletes only its locked orphan subset %j", async (lockedIds) => {
  const client = buildMockClient();
  const remaining = new Set([Q1, Q2]);
  client.query.mockImplementation(async (sql, params) => {
    if (/SELECT id FROM question_sets/.test(sql)) return { rows: [{ id: SET_ID }] };
    if (/SELECT question_id FROM question_set_questions/.test(sql)) {
      return { rows: [{ question_id: Q1 }, { question_id: Q2 }] };
    }
    if (/FOR UPDATE/.test(sql)) return { rows: lockedIds.map(id => ({ id })) };
    if (/DELETE FROM questions/.test(sql)) {
      // Both questions are now orphaned, but DELETE's id list must be bounded
      // by the preceding lock result, not the original cleanup candidates.
      params[0].forEach(id => remaining.delete(id));
    }
    return { rows: [], rowCount: 1 };
  });
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn() };
  const next = jest.fn();
  await handle({ params: { id: SET_ID } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(204);
  expect([...remaining]).toEqual([Q1, Q2].filter(id => !lockedIds.includes(id)));
  expect(client.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

// A merge can add a new set link while cleanup's locking SELECT waits on the
// canonical question row. The fresh DELETE snapshot must preserve that link.
test("cleanup preserves a question linked by a merge while its lock was awaited", async () => {
  const client = buildMockClient();
  const remaining = new Set([Q1]);
  client.query.mockImplementation(async (sql, params) => {
    if (/SELECT id FROM question_sets/.test(sql)) return { rows: [{ id: SET_ID }] };
    if (/SELECT question_id FROM question_set_questions/.test(sql)) return { rows: [{ question_id: Q1 }] };
    if (/FOR UPDATE/.test(sql)) return { rows: [{ id: Q1 }] };
    if (/DELETE FROM questions/.test(sql) && !/NOT EXISTS/.test(sql)) {
      params[0].forEach(id => remaining.delete(id));
    }
    return { rows: [], rowCount: 1 };
  });
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn() };
  const next = jest.fn();
  await handle({ params: { id: SET_ID } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(204);
  expect([...remaining]).toEqual([Q1]);
});
