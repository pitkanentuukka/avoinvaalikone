jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const { adminRouter } = require("../../src/routes/questionSets");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const SET_ID = "550e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID = "660e8400-e29b-41d4-a716-446655440000";
const staged = { id: SET_ID, status: "approved", hidden: true };
const routes = [
  ["add", "post", "/:id/questions", 201],
  ["remove", "delete", "/:id/questions/:questionId", 204],
];

beforeEach(resetDbMocks);

describe.each(routes)("%s a staged question", (_name, method, path, successStatus) => {
  const route = adminRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  const handle = route.stack[route.stack.length - 1].handle;

  function invoke() {
    const req = { params: { id: SET_ID, questionId: QUESTION_ID }, body: { statement: "Väittämä" } };
    const res = { status: jest.fn(), json: jest.fn(), end: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    return { res, next, done: handle(req, res, next) };
  }

  function setup(setRows) {
    const client = buildMockClient();
    client.query.mockImplementation(async (sql) => {
      if (/SELECT id, status, hidden FROM question_sets/.test(sql)) return { rows: setRows };
      if (/SELECT COALESCE/.test(sql)) return { rows: [{ max: 2 }] };
      if (/INSERT INTO questions/.test(sql)) return { rows: [{ id: QUESTION_ID, statement: "Väittämä" }] };
      return { rows: [], rowCount: 1 };
    });
    return client;
  }

  test("locks the set inside the transaction and keeps it locked through the edit", async () => {
    const client = setup([staged]);
    const { res, next, done } = invoke();
    await done;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(successStatus);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/SELECT id, status, hidden FROM question_sets WHERE id = \$1 FOR UPDATE/);
    expect(client.query.mock.calls[1][1]).toEqual([SET_ID]);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["missing set", [], 404],
    ["publishing won the lock", [{ ...staged, hidden: false }], 409],
    ["pending set", [{ ...staged, status: "pending" }], 409],
  ])("%s ends the transaction without changing questions", async (_case, rows, status) => {
    const client = setup(rows);
    const { res, next, done } = invoke();
    await done;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(status);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/FROM question_sets WHERE id = \$1 FOR UPDATE/),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
