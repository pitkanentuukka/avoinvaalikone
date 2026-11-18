jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);

const crypto = require("crypto");
const request = require("supertest");

// Issue #158: the public reads had no rate limit. A well-formed UUID that
// matches no candidate is a 404, which neither cache keeps, and every random
// UUID is a new URL to Cloudflare, so each such request was a database read:
// the cheapest unthrottled way past both caches to the database. Reads that
// reach the database are now limited per client IP; micro-cache hits don't
// count, so ordinary traffic (mostly hits) is unaffected.
//
// The app runs in production mode (the limiters and the micro-cache are
// production-only) with a mocked database and no Redis (memory store).

const LIMIT = 5;
let app;
let db;
let savedEnv;

beforeEach(() => {
  savedEnv = { NODE_ENV: process.env.NODE_ENV, MAX: process.env.RATE_LIMIT_PUBLIC_READ_MAX };
  process.env.NODE_ENV = "production";
  process.env.RATE_LIMIT_PUBLIC_READ_MAX = String(LIMIT);
  jest.isolateModules(() => {
    db = require("../../src/db/pool");
    app = require("../../src/index");
  });
  db.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  process.env.NODE_ENV = savedEnv.NODE_ENV;
  if (savedEnv.MAX === undefined) delete process.env.RATE_LIMIT_PUBLIC_READ_MAX;
  else process.env.RATE_LIMIT_PUBLIC_READ_MAX = savedEnv.MAX;
});

const randomCandidate = () => `/api/candidates/${crypto.randomUUID()}`;

test("random candidate ids are limited per client, bounding database reads", async () => {
  for (let i = 0; i < LIMIT; i++) {
    expect((await request(app).get(randomCandidate())).status).toBe(404);
  }
  const queriesBefore = db.query.mock.calls.length;

  for (let i = 0; i < 20; i++) {
    expect((await request(app).get(randomCandidate())).status).toBe(429);
  }
  expect(db.query.mock.calls.length).toBe(queriesBefore);
});

test("the 429 is never stored by a shared cache", async () => {
  for (let i = 0; i < LIMIT; i++) await request(app).get(randomCandidate());
  const res = await request(app).get(randomCandidate());
  expect(res.status).toBe(429);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).toEqual({ error: expect.any(String) });
});

test("micro-cache hits don't count toward the limit", async () => {
  for (let i = 0; i < LIMIT * 4; i++) {
    expect((await request(app).get("/api/candidates")).status).toBe(200);
    expect((await request(app).get("/api/question-sets")).status).toBe(200);
  }
  // Two misses so far, so random ids still have most of the budget.
  expect((await request(app).get(randomCandidate())).status).toBe(404);
});

test("every public read shares the one budget", async () => {
  for (let i = 0; i < LIMIT; i++) await request(app).get(randomCandidate());
  // Cold caches: these would be database reads.
  expect((await request(app).get("/api/candidates")).status).toBe(429);
  expect((await request(app).get("/api/question-sets")).status).toBe(429);
});

test("clients are limited separately", async () => {
  // Behind the proxies (TRUST_PROXY_HOPS, default 1) the client is the
  // X-Forwarded-For address.
  for (let i = 0; i < LIMIT; i++) {
    await request(app).get(randomCandidate()).set("X-Forwarded-For", "203.0.113.1");
  }
  expect((await request(app).get(randomCandidate()).set("X-Forwarded-For", "203.0.113.1")).status).toBe(429);
  expect((await request(app).get(randomCandidate()).set("X-Forwarded-For", "203.0.113.2")).status).toBe(404);
});

test("outside production public reads are not limited", async () => {
  process.env.NODE_ENV = "development";
  for (let i = 0; i < LIMIT * 3; i++) {
    expect((await request(app).get(randomCandidate())).status).toBe(404);
  }
});
