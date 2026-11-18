jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);

const crypto = require("crypto");
const request = require("supertest");

// Issue #158: the public reads had no rate limit. A well-formed UUID that
// matches no candidate is a 404, which the micro-cache doesn't keep (it keeps
// only 200s), and every random UUID is a new URL to Cloudflare, so each such
// request was a database read: the cheapest unthrottled way past both caches
// to the database. Failed public reads that reach the database are now
// limited per client IP. Successful ones aren't counted: the micro-cache
// already bounds them to about one read per resource per minute, and
// counting them could throttle a carrier CGNAT crowd on a cold edge cache.
//
// The app runs in production mode (the limiters and the micro-cache are
// production-only) with a mocked database and no Redis (memory store).

const LIMIT = 5;
let app;
let db;
let savedEnv;

// What Cloudflare → Caddy → nginx forward; without it production mode would
// redirect to https (and log that PUBLIC_HOST is unset).
const get = (path, a = app) => request(a).get(path).set("X-Forwarded-Proto", "https");
const head = (path) => request(app).head(path).set("X-Forwarded-Proto", "https");

beforeEach(() => {
  savedEnv = { NODE_ENV: process.env.NODE_ENV, MAX: process.env.RATE_LIMIT_PUBLIC_READ_MAX };
  process.env.NODE_ENV = "production";
  process.env.RATE_LIMIT_PUBLIC_READ_MAX = String(LIMIT);
  jest.isolateModules(() => {
    db = require("../../src/db/pool");
    app = require("../../src/index");
  });
  // Only ids from existingIds exist; the lists are empty.
  db.query.mockImplementation(async (sql, params) => ({
    rows: /WHERE c\.id = \$1/.test(sql) && existingIds.has(params[0])
      ? [{ id: params[0], name: "Ehdokas" }]
      : [],
  }));
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env.NODE_ENV = savedEnv.NODE_ENV;
  if (savedEnv.MAX === undefined) delete process.env.RATE_LIMIT_PUBLIC_READ_MAX;
  else process.env.RATE_LIMIT_PUBLIC_READ_MAX = savedEnv.MAX;
});

const existingIds = new Set(Array.from({ length: 50 }, () => crypto.randomUUID()));
const randomCandidate = () => `/api/candidates/${crypto.randomUUID()}`;
const useUp = async () => {
  for (let i = 0; i < LIMIT; i++) expect((await get(randomCandidate())).status).toBe(404);
};

test("random candidate ids are limited per client, bounding database reads", async () => {
  await useUp();
  const queriesBefore = db.query.mock.calls.length;
  for (let i = 0; i < 20; i++) {
    expect((await get(randomCandidate())).status).toBe(429);
  }
  expect(db.query.mock.calls.length).toBe(queriesBefore);
});

test("the 429 is never stored by a shared cache, and says when to retry", async () => {
  await useUp();
  const res = await get(randomCandidate());
  expect(res.status).toBe(429);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
  expect(res.body).toEqual({ error: expect.any(String) });
});

// The responses are public (s-maxage=300): a client's counter in them would
// be replayed by Cloudflare to everyone.
test("cacheable responses carry no client's rate-limit counters", async () => {
  for (const path of ["/api/candidates", "/api/question-sets", randomCandidate(), `/api/candidates/${[...existingIds][0]}`]) {
    const res = await get(path);
    expect(Object.keys(res.headers).filter((h) => /ratelimit/i.test(h))).toEqual([]);
  }
});

test("successful reads that reach the database don't count", async () => {
  // Every candidate page once: all misses, all 200.
  for (const id of existingIds) {
    expect((await get(`/api/candidates/${id}`)).status).toBe(200);
  }
  expect((await get(randomCandidate())).status).toBe(404);
});

test("micro-cache hits, HEAD and conditional requests included, don't count", async () => {
  const first = await get("/api/question-sets");
  for (let i = 0; i < LIMIT * 2; i++) {
    expect((await get("/api/question-sets")).headers["x-micro-cache"]).toBe("HIT");
    expect((await head("/api/question-sets")).status).toBe(200);
    expect((await get("/api/question-sets").set("If-None-Match", first.headers.etag)).status).toBe(304);
  }
  await useUp(); // the whole budget is still there
});

test("a malformed id is rejected before the limiter and not counted", async () => {
  for (let i = 0; i < LIMIT * 2; i++) {
    expect((await get("/api/candidates/not-a-uuid")).status).toBe(400);
  }
  await useUp();
});

test("every public read shares the one budget", async () => {
  await useUp();
  // Cold caches: these would be database reads.
  expect((await get("/api/candidates")).status).toBe(429);
  expect((await get("/api/question-sets")).status).toBe(429);
});

test("clients are limited separately", async () => {
  // Behind the proxies (TRUST_PROXY_HOPS, default 1) the client is the
  // X-Forwarded-For address.
  const from = (ip) => get(randomCandidate()).set("X-Forwarded-For", ip);
  for (let i = 0; i < LIMIT; i++) await from("203.0.113.1");
  expect((await from("203.0.113.1")).status).toBe(429);
  expect((await from("203.0.113.2")).status).toBe(404);
});

test("outside production public reads are not limited", async () => {
  process.env.NODE_ENV = "development";
  for (let i = 0; i < LIMIT * 3; i++) {
    expect((await get(randomCandidate())).status).toBe(404);
  }
});

test("with the rate-limit store failing, public reads still go through", async () => {
  // As with Redis down: every store call fails (src/middleware/rateLimiter.js
  // fails open on the store's StoreError).
  let failingApp;
  let failingDb;
  jest.isolateModules(() => {
    jest.doMock("../../src/middleware/rateLimitStore", () => {
      class StoreError extends Error {}
      const createStore = (prefix) => ({
        prefix,
        localKeys: false,
        init() {},
        increment: async () => {
          throw new StoreError("Redis down");
        },
        decrement: async () => {},
        resetKey: async () => {},
      });
      createStore.StoreError = StoreError;
      return createStore;
    });
    failingDb = require("../../src/db/pool");
    failingApp = require("../../src/index");
  });
  jest.dontMock("../../src/middleware/rateLimitStore");
  failingDb.query.mockResolvedValue({ rows: [] });

  for (let i = 0; i < LIMIT * 2; i++) {
    expect((await get(randomCandidate(), failingApp)).status).toBe(404);
  }
  expect((await get("/api/question-sets", failingApp)).status).toBe(200);
});
