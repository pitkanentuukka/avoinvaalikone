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
  // Issue #67: values of the wrong type must be rejected with the field's
  // message, not crash on .trim() (or, for truthy ones, claim "too long").
  ...[
    ["numeric ngoName", { ngoName: 1 }, /nimi ja otsikko vaaditaan/],
    ["object title", { title: {} }, /nimi ja otsikko vaaditaan/],
    ["ngoEmail false", { ngoEmail: false }, /Virheellinen sähköpostiosoite/],
    ["ngoEmail 0", { ngoEmail: 0 }, /Virheellinen sähköpostiosoite/],
    ["numeric ngoEmail", { ngoEmail: 1 }, /Virheellinen sähköpostiosoite/],
    ["logoUrl false", { logoUrl: false }, /Logon URL on virheellinen/],
    ["logoUrl 0", { logoUrl: 0 }, /Logon URL on virheellinen/],
    ["object logoUrl", { logoUrl: {} }, /Logon URL on virheellinen/],
  ].map(([name, fields, error]) => [
    `POST /api/question-sets: ${name}`,
    () => submit({ ngoName: "Järjestö", title: "Sarja", questions: ["Väittämä"], ...fields }),
    error,
  ]),
  ["POST /:id/questions: numeric statement", () => addQuestion({ statement: 1 }), /Väittämä vaaditaan/],
  ["review: null review item", () => review({ reviews: [null] }), /Virheellinen kysymyksen tunniste/],
  ["review: string review item", () => review({ reviews: ["x"] }), /Virheellinen kysymyksen tunniste/],
  ["review: missing questionId", () => review({ reviews: [{ rejected: true }] }), /Virheellinen kysymyksen tunniste/],
  ["review: invalid questionId", () => review({ reviews: [{ questionId: "x", rejected: true }] }), /Virheellinen kysymyksen tunniste/],
  ["review: numeric editedStatement", () => review({ reviews: [{ questionId: QUESTION_ID, editedStatement: 1 }] }), /Muokattu väittämä on virheellinen/],
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

// Pad rows to three columns: with fewer, jest passes `done` as the third argument.
test.each(cases.map(([name, send, error = null]) => [name, send, error]))("%s → 400 without a pool checkout", async (_name, send, error) => {
  const res = await send().timeout(REQUEST_TIMEOUT_MS);
  expect(res.status).toBe(400);
  if (error) expect(res.body.error).toMatch(error);
  expect(db.getClient).not.toHaveBeenCalled();
}, TIMEOUT_MS);
