jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const router = require("../../src/routes/parties");
const db = require("../../src/db/pool");

const route = router.stack.find(layer => layer.route?.path === "/:id/candidates").route;
const listCandidates = route.stack[route.stack.length - 1].handle;

beforeEach(() => db.query.mockReset());

// Counts are computed in SQL: verify the query's visibility rules instead of
// having a mock return the expected count independently of the query.
test("admin candidate list counts only answers to voter-visible questions, once per answer", async () => {
  const candidates = [{ id: "candidate-id", answer_count: "2" }];
  db.query.mockResolvedValueOnce({ rows: candidates });
  const req = { params: { id: "party-id" } };
  const res = { json: jest.fn() };
  const next = jest.fn();

  await listCandidates(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith(candidates);
  expect(db.query).toHaveBeenCalledTimes(1);
  const [sql, params] = db.query.mock.calls[0];
  const normalized = sql.replace(/\s+/g, " ");
  expect(params).toEqual([req.params.id]);
  expect(normalized).toMatch(/WHERE c\.party_id = \$1/);
  // EXISTS avoids multiplying the count for questions shared by several sets.
  expect(normalized).toMatch(/SELECT COUNT\(\*\) FROM candidate_answers ca WHERE ca\.candidate_id = c\.id AND EXISTS \(/);
  expect(normalized).toMatch(/FROM question_set_questions qsq JOIN question_sets qs ON qs\.id = qsq\.question_set_id/);
  expect(normalized).toMatch(/qsq\.question_id = ca\.question_id/);
  expect(normalized).toMatch(/qs\.status = 'approved'/);
  expect(normalized).toMatch(/qs\.hidden = false/);
  expect(normalized).toMatch(/\)\s*\) AS answer_count/);
});
