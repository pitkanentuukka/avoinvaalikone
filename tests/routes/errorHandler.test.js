// #229: outside production the catch-all error handler sent the error's own
// message as the JSON `error`: library internals in English, such as
// body-parser's "request entity too large", which the frontend shows as the
// app's own message. Every environment now answers in Finnish; outside
// production the raw message goes to `detail`, for debugging.
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);

const request = require("supertest");
const db = require("../../src/db/pool");

const ADMIN_SECRET = "test-admin-secret";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ADMIN_SECRET = process.env.ADMIN_SECRET;

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function loadApp(nodeEnv) {
  restore("NODE_ENV", nodeEnv);
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  let app;
  jest.isolateModules(() => { app = require("../../src/index"); });
  return app;
}

let consoleError;
beforeEach(() => { consoleError = jest.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => {
  consoleError.mockRestore();
  restore("NODE_ENV", ORIGINAL_NODE_ENV);
  restore("ADMIN_SECRET", ORIGINAL_ADMIN_SECRET);
  jest.clearAllMocks();
});

const malformedJson = (app) => request(app)
  .post("/api/voter/match").set("Content-Type", "application/json").send("{");
const tooLarge = (app) => request(app)
  .post("/api/voter/match").set("Content-Type", "application/json")
  .send(JSON.stringify({ answers: {}, padding: "x".repeat(1024 * 1024 + 1) }));
const failingQuery = (app) => {
  db.query.mockRejectedValueOnce(new Error('relation "parties" does not exist'));
  return request(app).get("/api/admin/parties").set("Authorization", `Bearer ${ADMIN_SECRET}`);
};

describe.each([
  ["development", "development"],
  ["unset", undefined],
  ["test", "test"],
])("outside production (NODE_ENV %s)", (_, nodeEnv) => {
  test("malformed JSON gets a Finnish 400, the parser's text only as detail", async () => {
    const res = await malformedJson(loadApp(nodeEnv));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Virheellinen pyyntö");
    expect(res.body.detail).toMatch(/JSON/);
  });

  test("a body over the limit gets a Finnish 413", async () => {
    const res = await tooLarge(loadApp(nodeEnv));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Pyyntö on liian suuri");
    expect(res.body.detail).toBe("request entity too large");
  });

  test("a server error says Palvelinvirhe, with the cause as detail", async () => {
    const res = await failingQuery(loadApp(nodeEnv));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Palvelinvirhe", detail: 'relation "parties" does not exist' });
  });
});

describe("in production", () => {
  test.each([
    ["malformed JSON", malformedJson, 400, "Virheellinen pyyntö"],
    ["a body over the limit", tooLarge, 413, "Pyyntö on liian suuri"],
    ["a server error", failingQuery, 500, "Palvelinvirhe"],
  ])("%s gets a Finnish message and no detail", async (_, send, status, error) => {
    const res = await send(loadApp("production"));
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
  });
});
