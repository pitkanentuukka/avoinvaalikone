const express = require("express");
const rateLimit = require("express-rate-limit");
const request = require("supertest");
const { FakeRedis, unusedPort } = require("../helpers/fakeRedis");

// The Redis-backed store behind express-rate-limit, configured like the
// limiters in src/index.js and src/routes/candidates.js (issue #149): it
// limits while Redis answers, and passOnStoreError lets requests through,
// quickly, while Redis is down or not answering. Uses the fake Redis; the
// scripts themselves are checked against a real one in
// rateLimitStoreRedis.test.js.

jest.setTimeout(20000);

let server;
let port;
let redis;
let createStore;
let consoleError;

// node-redis reconnects with backoff, at most ~2.2 s apart.
function waitReady(timeoutMs = 5000) {
  if (redis.isReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off("ready", onReady);
      reject(new Error(`Redis client not ready within ${timeoutMs} ms`));
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    redis.once("ready", onReady);
  });
}

function limitedApp(prefix) {
  const app = express();
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    store: createStore(prefix),
    passOnStoreError: true,
  }));
  app.get("/", (req, res) => res.send("ok"));
  return app;
}

beforeAll(() => {
  // A fixed port the client keeps reconnecting to; each test starts its own
  // fake Redis there.
  return unusedPort().then((p) => {
    port = p;
    jest.isolateModules(() => {
      process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
      redis = require("../../src/redis");
      createStore = require("../../src/middleware/rateLimitStore");
    });
    process.env.REDIS_URL = "";
  });
});

beforeEach(async () => {
  // express-rate-limit and src/redis.js log every store and connection error.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  server = new FakeRedis("ok");
  await server.listen(port);
  await waitReady();
});

afterEach(async () => {
  await server.stop();
  consoleError.mockRestore();
});

afterAll(() => redis.destroy());

async function stopRedis() {
  await server.stop();
  // Let the client see the dropped connection.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

test("limits requests while Redis answers", async () => {
  const app = limitedApp("rl:mw:up:");
  expect((await request(app).get("/")).status).toBe(200);
  expect((await request(app).get("/")).status).toBe(200);
  expect((await request(app).get("/")).status).toBe(429);
});

test("lets requests through at once while Redis is down", async () => {
  const app = limitedApp("rl:mw:down:");
  await stopRedis();

  const started = Date.now();
  for (let i = 0; i < 3; i++) expect((await request(app).get("/")).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("allowing request without rate-limiting"),
    expect.anything()
  );
});

test("lets a request through within the store timeout while Redis doesn't answer", async () => {
  server.mode = "hang";
  const app = limitedApp("rl:mw:hang:");

  const started = Date.now();
  expect((await request(app).get("/")).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2500);
});

// express-rate-limit awaits store.decrement() inside response "finish",
// "close" and "error" handlers that catch nothing (skipFailedRequests,
// skipSuccessfulRequests), so a rejection there would exit Node: the crash
// of issue #149 again.
test("decrement doesn't reject while Redis is down", async () => {
  const store = createStore("rl:mw:decrement:");
  store.init({ windowMs: 60 * 1000 });
  await stopRedis();

  await expect(store.decrement("client")).resolves.toBeUndefined();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("decrement"),
    expect.anything()
  );
});

test("a limiter that uncounts failed requests survives Redis going down mid-request", async () => {
  const app = express();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    store: createStore("rl:mw:skip-failed:"),
    passOnStoreError: true,
    skipFailedRequests: true,
  }));
  app.get("/", async (req, res) => {
    await held;
    res.status(500).send("failed");
  });

  const response = request(app).get("/").then((res) => res);
  // The increment has gone through; Redis goes away before the response.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await stopRedis();
  release();
  expect((await response).status).toBe(500);
  // The uncounting decrement runs on "finish"; give it time to fail.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("decrement"),
    expect.anything()
  );
});
