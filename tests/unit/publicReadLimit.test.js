jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);

const crypto = require("crypto");
const request = require("supertest");

// Issue #158: the public reads had no rate limit, so a client walking
// candidate ids, random (each a 404 the micro-cache doesn't keep) or existing
// (more than the micro-cache holds), each a new URL to Cloudflare, cost a
// database read per request past both caches. Public reads that reach the
// database are now limited per client IP:
// - candidate pages: every miss counts;
// - the candidate list and the question sets: only failed reads count (the
//   micro-cache bounds their successful reads to one per replica per minute,
//   and a CGNAT crowd on a cold edge must not be throttled out of the quiz).
//
// The app runs in production mode (the limiters and the micro-cache are
// production-only) with a mocked database and no Redis (memory store).

const CANDIDATE_LIMIT = 8;
const LIST_LIMIT = 5;
let app;
let db;
let savedEnv;
let failLists;

// What Cloudflare → Caddy → nginx forward; without it production mode would
// redirect to https (and log that PUBLIC_HOST is unset).
const get = (path, a = app) => request(a).get(path).set("X-Forwarded-Proto", "https");

const ENV = ["NODE_ENV", "RATE_LIMIT_PUBLIC_READ_MAX", "RATE_LIMIT_CANDIDATE_READ_MAX"];
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.NODE_ENV = "production";
  process.env.RATE_LIMIT_PUBLIC_READ_MAX = String(LIST_LIMIT);
  process.env.RATE_LIMIT_CANDIDATE_READ_MAX = String(CANDIDATE_LIMIT);
  jest.isolateModules(() => {
    db = require("../../src/db/pool");
    app = require("../../src/index");
  });
  failLists = false;
  // Only ids from existingIds exist; the lists are empty, or fail.
  db.query.mockImplementation(async (sql, params) => {
    if (/WHERE c\.id = \$1/.test(sql)) {
      return { rows: existingIds.has(params[0]) ? [{ id: params[0], name: "Ehdokas" }] : [] };
    }
    if (/candidate_answers/.test(sql)) return { rows: [] };
    if (failLists) throw new Error("statement timeout");
    return { rows: [] };
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const existingIds = [...Array(50)].map(() => crypto.randomUUID());
existingIds.has = (id) => existingIds.includes(id);
const randomCandidate = () => `/api/candidates/${crypto.randomUUID()}`;
const useUpCandidates = async () => {
  for (let i = 0; i < CANDIDATE_LIMIT; i++) expect((await get(randomCandidate())).status).toBe(404);
};

describe("candidate pages", () => {
  test("random ids are limited per client, bounding database reads", async () => {
    await useUpCandidates();
    const queriesBefore = db.query.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      expect((await get(randomCandidate())).status).toBe(429);
    }
    expect(db.query.mock.calls.length).toBe(queriesBefore);
  });

  // Review round 2: with only failures counted, cycling through more
  // existing ids than the micro-cache holds (or the same ids with a new
  // query string, past Cloudflare) was 2 uncounted queries per request.
  test("existing ids that miss the cache count too", async () => {
    for (let i = 0; i < CANDIDATE_LIMIT; i++) {
      expect((await get(`/api/candidates/${existingIds[i]}?x=${i}`)).status).toBe(200);
    }
    expect((await get(`/api/candidates/${existingIds[CANDIDATE_LIMIT]}`)).status).toBe(429);
  });

  test("micro-cache hits don't count", async () => {
    const page = `/api/candidates/${existingIds[0]}`;
    expect((await get(page)).status).toBe(200);
    for (let i = 0; i < CANDIDATE_LIMIT * 2; i++) {
      expect((await get(`${page}?x=${i}`)).headers["x-micro-cache"]).toBe("HIT");
    }
    for (let i = 1; i < CANDIDATE_LIMIT; i++) expect((await get(randomCandidate())).status).toBe(404);
    expect((await get(randomCandidate())).status).toBe(429);
  });

  test("a malformed id is rejected before the limiter and not counted", async () => {
    for (let i = 0; i < CANDIDATE_LIMIT * 2; i++) {
      expect((await get("/api/candidates/not-a-uuid")).status).toBe(400);
    }
    await useUpCandidates();
  });
});

describe("the lists", () => {
  test("successful reads that reach the database don't count, HEAD and 304 included", async () => {
    // With the micro-cache passing everything through, every read is a miss.
    let missApp;
    jest.isolateModules(() => {
      jest.doMock("../../src/middleware/microCache", () => () => (req, res, next) => next());
      require("../../src/db/pool").query.mockImplementation(db.query.getMockImplementation());
      missApp = require("../../src/index");
    });
    jest.dontMock("../../src/middleware/microCache");
    const miss = (path) => request(missApp).get(path).set("X-Forwarded-Proto", "https");
    const etag = (await miss("/api/question-sets")).headers.etag;
    for (let i = 0; i < LIST_LIMIT * 2; i++) {
      expect((await miss("/api/question-sets")).status).toBe(200);
      expect((await request(missApp).head("/api/candidates").set("X-Forwarded-Proto", "https")).status).toBe(200);
      expect((await miss("/api/question-sets").set("If-None-Match", etag)).status).toBe(304);
    }
  });

  test("failed reads count, a database error included", async () => {
    failLists = true;
    for (let i = 0; i < LIST_LIMIT; i++) expect((await get("/api/question-sets")).status).toBe(500);
    expect((await get("/api/question-sets")).status).toBe(429);
    expect((await get("/api/candidates")).status).toBe(429); // one budget for both lists
  });

  test("their budget is separate from the candidate pages'", async () => {
    await useUpCandidates();
    expect((await get(randomCandidate())).status).toBe(429);
    expect((await get("/api/candidates")).status).toBe(200);
    expect((await get("/api/question-sets")).status).toBe(200);
  });
});

test("the 429 is never stored by a shared cache, and says when to retry", async () => {
  await useUpCandidates();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await get(randomCandidate());
  expect(res.status).toBe(429);
  expect(res.headers["cache-control"]).toBe("no-store");
  // From the window's reset time, not a fixed 60.
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  expect(Number(res.headers["retry-after"])).toBeLessThan(60);
  expect(res.body).toEqual({ error: expect.any(String) });
});

// The responses are public (s-maxage=300): a client's counter in them would
// be replayed by Cloudflare to everyone.
test("cacheable responses carry no client's rate-limit counters", async () => {
  for (const path of ["/api/candidates", "/api/question-sets", randomCandidate(), `/api/candidates/${existingIds[0]}`]) {
    const res = await get(path);
    expect(Object.keys(res.headers).filter((h) => /ratelimit/i.test(h))).toEqual([]);
  }
});

test("clients are limited separately", async () => {
  // Behind the proxies (TRUST_PROXY_HOPS, default 1) the client is the
  // X-Forwarded-For address.
  const from = (ip) => get(randomCandidate()).set("X-Forwarded-For", ip);
  for (let i = 0; i < CANDIDATE_LIMIT; i++) await from("203.0.113.1");
  expect((await from("203.0.113.1")).status).toBe(429);
  expect((await from("203.0.113.2")).status).toBe(404);
});

test("outside production public reads are not limited", async () => {
  process.env.NODE_ENV = "development";
  for (let i = 0; i < CANDIDATE_LIMIT * 3; i++) {
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

  for (let i = 0; i < CANDIDATE_LIMIT * 2; i++) {
    expect((await get(randomCandidate(), failingApp)).status).toBe(404);
  }
  expect((await get("/api/question-sets", failingApp)).status).toBe(200);
});
