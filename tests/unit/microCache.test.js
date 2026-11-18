const express = require("express");
const request = require("supertest");
const { createMicroCache } = require("../../src/middleware/microCache");
const { validateUUIDParam } = require("../../src/middleware/validation");

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
  // As in src/routes/candidates.js, validation runs before the cache, which
  // is what makes lowercasing the id in the key safe.
  candidates.get("/:id", validateUUIDParam("id"), microCache(), (req, res) => {
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

test("the entry limit evicts the oldest entries", async () => {
  const microCache = createMicroCache({ maxEntries: 3 });
  const { app, calls } = buildApp(microCache);
  const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

  for (const id of ids) {
    expect((await request(app).get(`/api/candidates/${id}`)).status).toBe(200);
    expect(microCache.stats().entries).toBeLessThanOrEqual(3);
  }
  // The newest three are still cached, the oldest was evicted.
  for (const id of ids.slice(-3)) {
    expect((await request(app).get(`/api/candidates/${id}`)).headers["x-micro-cache"]).toBe("HIT");
  }
  expect((await request(app).get(`/api/candidates/${ids[0]}`)).headers["x-micro-cache"]).toBeUndefined();
  expect(calls.one).toBe(11);
});

test("an invalid id is rejected before the cache and not stored", async () => {
  const microCache = createMicroCache();
  const { app, calls } = buildApp(microCache);

  expect((await request(app).get("/api/candidates/not-a-uuid")).status).toBe(400);
  expect(calls.one).toBe(0);
  expect(microCache.stats().entries).toBe(0);
});

test("a hit serves non-Latin-1 text as identical UTF-8 JSON", async () => {
  const microCache = createMicroCache();
  const bio = "Ääni – \u201cvaalit\u201d 🗳️";
  const { app } = buildApp(microCache, { listBody: [{ bio }] });

  const miss = await request(app).get("/api/candidates");
  const hit = await request(app).get("/api/candidates");
  expect(hit.headers["x-micro-cache"]).toBe("HIT");
  expect(hit.headers["content-type"]).toBe("application/json; charset=utf-8");
  expect(hit.text).toBe(miss.text);
  expect(hit.body).toEqual([{ bio }]);
  // The counted size is the UTF-8 size actually retained.
  expect(microCache.stats().bytes).toBe(Buffer.byteLength(miss.text));
});

test("mounted with router.use(), requests pass through uncached", async () => {
  // Without a declared route path the raw path would be the key, and its
  // spelling variants would multiply entries again.
  const microCache = createMicroCache();
  const router = express.Router();
  let calls = 0;
  router.use(microCache());
  router.get("/", (req, res) => {
    calls++;
    res.json([]);
  });
  const app = express();
  app.use("/api/question-sets", router);

  for (let i = 0; i < 3; i++) {
    expect((await request(app).get(`/api/question-sets?unused=${i}`)).status).toBe(200);
  }
  expect(calls).toBe(3);
  expect(microCache.stats().entries).toBe(0);
});

test("only GET and HEAD are served from the cache", async () => {
  const microCache = createMicroCache();
  const router = express.Router();
  const calls = [];
  router.all("/", microCache(), (req, res) => {
    calls.push(req.method);
    res.json({ method: req.method });
  });
  const app = express();
  app.use("/api/question-sets", router);

  expect((await request(app).get("/api/question-sets")).body).toEqual({ method: "GET" });
  const post = await request(app).post("/api/question-sets").send({});
  expect(post.headers["x-micro-cache"]).toBeUndefined();
  expect(post.body).toEqual({ method: "POST" });
  expect(calls).toEqual(["GET", "POST"]);
  expect(microCache.stats().entries).toBe(1);
});

test("a hit answers HEAD and conditional GETs like a miss", async () => {
  const microCache = createMicroCache();
  const { app } = buildApp(microCache);

  const miss = await request(app).get("/api/candidates");
  const hit = await request(app).get("/api/candidates");
  expect(hit.headers["x-micro-cache"]).toBe("HIT");
  for (const header of ["etag", "content-length", "content-type"]) {
    expect(hit.headers[header]).toBe(miss.headers[header]);
  }

  const head = await request(app).head("/api/candidates");
  expect(head.status).toBe(200);
  expect(head.headers["x-micro-cache"]).toBe("HIT");
  expect(head.headers["content-length"]).toBe(miss.headers["content-length"]);

  const notModified = await request(app).get("/api/candidates").set("If-None-Match", miss.headers.etag);
  expect(notModified.status).toBe(304);
  expect(notModified.headers["x-micro-cache"]).toBe("HIT");
});

test("concurrent misses for one key are counted once", async () => {
  const microCache = createMicroCache();
  const router = express.Router();
  const body = { bio: "x".repeat(100) };
  router.get("/", microCache(), (req, res) => {
    setTimeout(() => res.json(body), 20);
  });
  const app = express();
  app.use("/api/candidates", router);

  // All four miss before the first one stores its body.
  const responses = await Promise.all(Array.from({ length: 4 }, () => request(app).get("/api/candidates")));
  for (const res of responses) expect(res.status).toBe(200);
  expect(microCache.stats()).toEqual({ entries: 1, bytes: Buffer.byteLength(JSON.stringify(body)) });
});

test("RegExp and array routes pass through uncached", async () => {
  const microCache = createMicroCache();
  const router = express.Router();
  router.get(/^\/a$/, microCache(), (req, res) => res.json({ route: "a" }));
  router.get(/^\/b$/, microCache(), (req, res) => res.json({ route: "b" }));
  router.get(["/x", "/y"], microCache(), (req, res) => res.json({ route: req.path }));
  const app = express();
  app.use("/api/candidates", router);

  expect((await request(app).get("/api/candidates/a")).body).toEqual({ route: "a" });
  expect((await request(app).get("/api/candidates/b")).body).toEqual({ route: "b" });
  expect((await request(app).get("/api/candidates/x")).body).toEqual({ route: "/x" });
  expect((await request(app).get("/api/candidates/y")).body).toEqual({ route: "/y" });
  expect(microCache.stats().entries).toBe(0);
});

// Issue #160: eviction was oldest-first by insertion, and a hit didn't
// refresh an entry, so with the 500-entry cap a walk over ~500 distinct
// candidate pages pushed the candidate list (the most expensive entry) out,
// and a cyclic walk over all ~2,500 candidates never hit at all.
const CANDIDATES = 2500; // the expected candidate count, all ids public
const candidateId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("eviction under the default limits", () => {
  let server;
  afterEach(() => server && server.close());

  test("500 candidate reads don't evict the candidate list", async () => {
    const { app, calls } = buildApp(createMicroCache());
    server = app.listen(0);

    expect((await request(server).get("/api/candidates")).status).toBe(200);
    for (let i = 0; i < 500; i++) {
      expect((await request(server).get(`/api/candidates/${candidateId(i)}`)).status).toBe(200);
    }
    const res = await request(server).get("/api/candidates");
    expect(res.headers["x-micro-cache"]).toBe("HIT");
    expect(calls.list).toBe(1);
  });

  test("a second walk over every candidate page is served from the cache", async () => {
    const { app, calls } = buildApp(createMicroCache());
    server = app.listen(0);

    expect((await request(server).get("/api/candidates")).status).toBe(200);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < CANDIDATES; i++) {
        expect((await request(server).get(`/api/candidates/${candidateId(i)}`)).status).toBe(200);
      }
    }
    expect(calls.one).toBe(CANDIDATES);
    expect((await request(server).get("/api/candidates")).headers["x-micro-cache"]).toBe("HIT");
  }, 60_000);
});

test("a hit makes an entry the last to be evicted by the entry limit", async () => {
  const microCache = createMicroCache({ maxEntries: 3 });
  const { app, calls } = buildApp(microCache);
  const get = (path) => request(app).get(path);

  await get("/api/candidates"); // oldest
  await get(`/api/candidates/${candidateId(1)}`);
  await get(`/api/candidates/${candidateId(2)}`);
  expect((await get("/api/candidates")).headers["x-micro-cache"]).toBe("HIT");
  await get(`/api/candidates/${candidateId(3)}`); // evicts id 1, not the list

  expect((await get("/api/candidates")).headers["x-micro-cache"]).toBe("HIT");
  expect(calls.list).toBe(1);
  expect((await get(`/api/candidates/${candidateId(1)}`)).headers["x-micro-cache"]).toBeUndefined();
});

test("a hit makes an entry the last to be evicted by the byte budget", async () => {
  // Each body is a little over 1000 bytes; the budget fits three of them.
  const microCache = createMicroCache({ maxBytes: 3500 });
  const candidates = express.Router();
  let runs = 0;
  candidates.get("/:id", microCache(), (req, res) => {
    runs++;
    res.json({ id: req.params.id, bio: "x".repeat(1000) });
  });
  const app = express();
  app.use("/api/candidates", candidates);
  const get = (i) => request(app).get(`/api/candidates/${candidateId(i)}`);

  await get(0);
  await get(1);
  await get(2);
  expect((await get(0)).headers["x-micro-cache"]).toBe("HIT");
  await get(3); // evicts 1, the least recently used

  expect((await get(0)).headers["x-micro-cache"]).toBe("HIT");
  expect((await get(1)).headers["x-micro-cache"]).toBeUndefined();
  expect(runs).toBe(5);
});
