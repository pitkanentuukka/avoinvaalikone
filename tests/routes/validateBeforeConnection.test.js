jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { resetDbMocks } = require("../helpers/mockDb");

// Issue #27: a request whose body fails synchronous validation must get its
// 400 without checking out a pool connection. Otherwise, with the pool
// exhausted, junk requests wait out connectionTimeoutMillis, end in a 500, and
// compete with real requests for connections while they wait.
const REQUEST_TIMEOUT_MS = 2000;
const TIMEOUT_MS = 3000;

const ADMIN_SECRET = "test-admin-secret";
const SET_ID = "550e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID = "660e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID2 = "770e8400-e29b-41d4-a716-446655440000";

const admin = (req) => req.set("Authorization", `Bearer ${ADMIN_SECRET}`);

const submit = (body) => request(app).post("/api/question-sets").send(body);
const merge = (body) => admin(request(app).post("/api/admin/question-sets/merge-questions")).send(body);
const review = (body) => admin(request(app).patch(`/api/admin/question-sets/${SET_ID}/review`)).send(body);
const addQuestion = (body) => admin(request(app).post(`/api/admin/question-sets/${SET_ID}/questions`)).send(body);

const cases = [
  ["POST /api/question-sets: missing title", () => submit({ ngoName: "Järjestö", questions: ["Väittämä"] })],
  ["POST /api/question-sets: invalid email", () => submit({ ngoName: "Järjestö", title: "Sarja", ngoEmail: "x", questions: ["Väittämä"] })],
  ["POST /api/question-sets: invalid logo URL", () => submit({ ngoName: "Järjestö", title: "Sarja", logoUrl: "ftp://x", questions: ["Väittämä"] })],
  ["POST /api/question-sets: no questions", () => submit({ ngoName: "Järjestö", title: "Sarja", questions: [] })],
  ["POST /api/question-sets: too many questions", () => submit({ ngoName: "Järjestö", title: "Sarja", questions: Array(51).fill("Väittämä") })],
  ["POST /api/question-sets: statement too long", () => submit({ ngoName: "Järjestö", title: "Sarja", questions: ["a".repeat(501)] })],
  ["POST /api/question-sets: only blank statements", () => submit({ ngoName: "Järjestö", title: "Sarja", questions: ["  "] })],
  ["merge-questions: invalid keepId", () => merge({ keepId: "nope", dropIds: [QUESTION_ID2] })],
  ["merge-questions: empty dropIds", () => merge({ keepId: QUESTION_ID, dropIds: [] })],
  ["merge-questions: invalid dropId", () => merge({ keepId: QUESTION_ID, dropIds: ["nope"] })],
  ["merge-questions: merge into itself", () => merge({ keepId: QUESTION_ID, dropIds: [QUESTION_ID] })],
  ["review: missing reviews", () => review({})],
  ["review: edited statement too long", () => review({ reviews: [{ questionId: QUESTION_ID, editedStatement: "a".repeat(501) }] })],
  ["review: invalid duplicateOf", () => review({ reviews: [{ questionId: QUESTION_ID, duplicateOf: "nope" }] })],
  ["POST /:id/questions: missing statement", () => addQuestion({})],
  ["POST /:id/questions: statement too long", () => addQuestion({ statement: "a".repeat(501) })],
  // Issue #67: values of the wrong type must be rejected, not crash on .trim().
  ["POST /api/question-sets: numeric ngoName", () => submit({ ngoName: 1, title: "Sarja", questions: ["Väittämä"] })],
  ["POST /api/question-sets: object title", () => submit({ ngoName: "Järjestö", title: {}, questions: ["Väittämä"] })],
  ["POST /:id/questions: numeric statement", () => addQuestion({ statement: 1 })],
  ["review: null review item", () => review({ reviews: [null] })],
  ["review: string review item", () => review({ reviews: ["x"] })],
  ["review: missing questionId", () => review({ reviews: [{ rejected: true }] })],
  ["review: invalid questionId", () => review({ reviews: [{ questionId: "x", rejected: true }] })],
];

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  resetDbMocks();
  // The pool is exhausted: any checkout fails the way pg's connectionTimeoutMillis does.
  db.getClient.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

test.each(cases)("%s → 400 without a pool checkout", async (_name, send) => {
  const res = await send().timeout(REQUEST_TIMEOUT_MS);
  expect(res.status).toBe(400);
  expect(db.getClient).not.toHaveBeenCalled();
}, TIMEOUT_MS);
