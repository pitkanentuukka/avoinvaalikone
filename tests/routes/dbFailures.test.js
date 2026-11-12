jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

// Every route that checks out a transaction client must answer 500 when the
// pool or the connection fails. Express 4 ignores rejected promises from
// async handlers, so an uncaught failure hangs the request and crashes the
// process on unhandledRejection (issue #5). A short timeout turns a hang into
// a test failure instead of a stuck run.
const TIMEOUT_MS = 3000;

const ADMIN_SECRET = "test-admin-secret";
const SET_ID = "550e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID = "660e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID2 = "770e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_TOKEN = "c".repeat(48);
const CANDIDATE_AUTH = {
  id: "880e8400-e29b-41d4-a716-446655440000",
  party_id: "990e8400-e29b-41d4-a716-446655440000",
  party_name: "Vihreät",
};

const admin = (req) => req.set("Authorization", `Bearer ${ADMIN_SECRET}`);

const routes = [
  {
    name: "PUT /api/candidates/me/:candidateToken/answers",
    setup: () => db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] }),
    send: () =>
      request(app)
        .put(`/api/candidates/me/${CANDIDATE_TOKEN}/answers`)
        .send({ answers: { [QUESTION_ID]: { value: 2 } } }),
  },
  {
    name: "POST /api/question-sets",
    send: () =>
      request(app)
        .post("/api/question-sets")
        .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: ["Väittämä 1"] }),
  },
  {
    name: "POST /api/admin/question-sets/merge-questions",
    send: () =>
      admin(request(app).post("/api/admin/question-sets/merge-questions"))
        .send({ keepId: QUESTION_ID, dropIds: [QUESTION_ID2] }),
  },
  {
    name: "PATCH /api/admin/question-sets/:id/review",
    send: () =>
      admin(request(app).patch(`/api/admin/question-sets/${SET_ID}/review`))
        .send({ reviews: [{ questionId: QUESTION_ID }] }),
  },
  {
    name: "POST /api/admin/question-sets/:id/questions",
    send: () =>
      admin(request(app).post(`/api/admin/question-sets/${SET_ID}/questions`))
        .send({ statement: "Uusi väittämä" }),
  },
  {
    name: "DELETE /api/admin/question-sets/:id/questions/:questionId",
    send: () => admin(request(app).delete(`/api/admin/question-sets/${SET_ID}/questions/${QUESTION_ID}`)),
  },
  {
    name: "DELETE /api/admin/question-sets/:id",
    send: () => admin(request(app).delete(`/api/admin/question-sets/${SET_ID}`)),
  },
];

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  resetDbMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe.each(routes)("$name", ({ setup, send }) => {
  test("pool timeout in getClient → 500", async () => {
    setup?.();
    db.getClient.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    const res = await send();
    expect(res.status).toBe(500);
  }, TIMEOUT_MS);

  test("dead connection (ROLLBACK fails too) → 500, rollback attempted, client released", async () => {
    setup?.();
    const client = buildMockClient();
    client.query.mockRejectedValue(new Error("Connection terminated unexpectedly"));

    const res = await send();
    expect(res.status).toBe(500);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  }, TIMEOUT_MS);
});
