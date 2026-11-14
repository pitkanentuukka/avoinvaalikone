jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const router = require("../../src/routes/candidates");
const db = require("../../src/db/pool");

const route = router.stack.find(layer => layer.route?.path === "/party/:partyToken").route;
const overview = route.stack[route.stack.length - 1].handle;

beforeEach(() => db.query.mockReset());

// The count is computed in SQL, so check the query contract rather than
// teaching a mock database to return the desired count regardless of the SQL.
test("party progress counts only answers to voter-visible questions, once per answer", async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const req = { party: { id: "party-id", name: "Puolue", registration_token: "registration-token" } };
  const res = { json: jest.fn() };
  const next = jest.fn();

  await overview(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(db.query).toHaveBeenCalledTimes(1);
  const [sql, params] = db.query.mock.calls[0];
  const normalized = sql.replace(/\s+/g, " ");
  expect(params).toEqual([req.party.id]);
  expect(normalized).toMatch(/FROM candidates c WHERE c\.party_id = \$1/);
  // EXISTS avoids multiplying the count for questions shared by several sets.
  expect(normalized).toMatch(/FROM candidate_answers ca WHERE ca\.candidate_id = c\.id AND EXISTS \(/);
  expect(normalized).toMatch(/FROM question_set_questions qsq JOIN question_sets qs ON qs\.id = qsq\.question_set_id/);
  expect(normalized).toMatch(/qsq\.question_id = ca\.question_id/);
  expect(normalized).toMatch(/qs\.status = 'approved'/);
  expect(normalized).toMatch(/qs\.hidden = false/);
  expect(normalized).toMatch(/\)\s*\) AS answer_count/);
});
