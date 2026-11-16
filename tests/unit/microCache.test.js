const express = require("express");
const request = require("supertest");
const { createMicroCache } = require("../../src/middleware/microCache");

// Issue #150: the public micro-cache keyed entries by req.originalUrl, so
// every unused query string (?unused=1, ?unused=2, …) cost a database read
// and kept another full copy of the same response, bounded only by entry
// count, and expired copies stayed allocated until evicted.

const ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

// The cached routes and mounts of src/index.js, with handlers that count how
// often they run (each run is a database read in the real app).
function buildApp(microCache, { listBody = [{ bio: "x".repeat(1000) }] } = {}) {
  const calls = { list: 0, one: 0, sets: 0 };
  const candidates = express.Router();
  candidates.get("/", microCache(), (req, res) => {
    calls.list++;
    res.json(listBody);
  });
  candidates.get("/:id", microCache(), (req, res) => {
    calls.one++;
    res.json({ id: req.params.id.toLowerCase() });
  });
  const sets = express.Router();
  sets.get("/", microCache(), (req, res) => {
    calls.sets++;
    res.json([]);
  });
  const app = express();
  app.use("/api/candidates", candidates);
  app.use("/api/question-sets", sets);
  return { app, calls };
}

let savedEnv;
beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production"; // the cache is production-only
});
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
  jest.restoreAllMocks();
});

test("unused query parameters share one cache entry", async () => {
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);

  const first = await request(app).get("/api/candidates");
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/candidates?unused=${i}`);
    expect(res.status).toBe(200);
    expect(res.headers["x-micro-cache"]).toBe("HIT");
    expect(res.body).toEqual(first.body);
  }

  expect(calls.list).toBe(1);
  expect(microCache.stats().entries).toBe(1);
});

test("spelling variants of the same path share one entry", async () => {
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);

  for (const path of ["/api/candidates", "/api/candidates/", "/API/Candidates", "/api/candidates?a=1&b=2"]) {
    expect((await request(app).get(path)).status).toBe(200);
  }
  for (const path of [`/api/candidates/${ID}`, `/api/candidates/${ID.toUpperCase()}`, `/api/candidates/${ID}/?x=1`]) {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ID });
  }

  expect(calls.list).toBe(1);
  expect(calls.one).toBe(1);
  expect(microCache.stats().entries).toBe(2);
});

test("different resources keep separate entries", async () => {
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);

  expect((await request(app).get(`/api/candidates/${ID}`)).body).toEqual({ id: ID });
  expect((await request(app).get(`/api/candidates/${OTHER_ID}`)).body).toEqual({ id: OTHER_ID });
  // Both routers' list routes are "/", but they are different endpoints.
  expect((await request(app).get("/api/candidates")).body).toEqual([{ bio: "x".repeat(1000) }]);
  expect((await request(app).get("/api/question-sets")).body).toEqual([]);

  expect(calls).toEqual({ list: 1, one: 2, sets: 1 });
  expect(microCache.stats().entries).toBe(4);
});

test("retained bodies never exceed the byte budget", async () => {
  // Each body is a little over 1000 bytes; the budget fits three of them.
  const microCache = createMicroCache({ maxEntries: 500, maxBytes: 3500 });
  const candidates = express.Router();
  candidates.get("/:id", microCache(), (req, res) => res.json({ id: req.params.id, bio: "x".repeat(1000) }));
  const app = express();
  app.use("/api/candidates", candidates);

  for (let i = 0; i < 20; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    expect((await request(app).get(`/api/candidates/${id}`)).status).toBe(200);
    expect(microCache.stats().bytes).toBeLessThanOrEqual(3500);
  }
  expect(microCache.stats().entries).toBe(3);
});

test("a body larger than the whole budget is served but not kept", async () => {
  const microCache = createMicroCache({ maxEntries: 500, maxBytes: 500 });
  const { app, calls } = buildApp(microCache); // list body is ~1000 bytes

  expect((await request(app).get("/api/candidates")).status).toBe(200);
  expect((await request(app).get("/api/candidates")).status).toBe(200);
  expect(calls.list).toBe(2);
  expect(microCache.stats()).toEqual({ entries: 0, bytes: 0 });
});

test("expired entries are reclaimed", async () => {
  const microCache = createMicroCache();
  const { app } = buildApp(microCache);
  let now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);

  await request(app).get("/api/candidates");
  await request(app).get(`/api/candidates/${ID}`);
  expect(microCache.stats().entries).toBe(2);

  now += 61_000; // past the 60 s TTL
  await request(app).get("/api/question-sets");

  // Only the fresh entry is still held; the expired copies were released.
  const fresh = microCache.stats();
  expect(fresh.entries).toBe(1);
  expect(fresh.bytes).toBe(Buffer.byteLength("[]"));
});

test("an expired entry is replaced, not served", async () => {
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);
  let now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);

  await request(app).get("/api/candidates");
  now += 61_000;
  const res = await request(app).get("/api/candidates");
  expect(res.headers["x-micro-cache"]).toBeUndefined();
  expect(calls.list).toBe(2);
  expect(microCache.stats().entries).toBe(1);
});

test("non-200 responses are not cached", async () => {
  const microCache = createMicroCache();
  const router = express.Router();
  let calls = 0;
  router.get("/:id", microCache(), (req, res) => {
    calls++;
    res.status(404).json({ error: "Ehdokasta ei löytynyt" });
  });
  const app = express();
  app.use("/api/candidates", router);

  await request(app).get(`/api/candidates/${ID}`);
  await request(app).get(`/api/candidates/${ID}`);
  expect(calls).toBe(2);
  expect(microCache.stats().entries).toBe(0);
});

test("the cache is off outside production", async () => {
  process.env.NODE_ENV = "test";
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);

  await request(app).get("/api/candidates");
  await request(app).get("/api/candidates");
  expect(calls.list).toBe(2);
  expect(microCache.stats().entries).toBe(0);
});
