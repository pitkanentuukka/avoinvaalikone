const express = require("express");
const request = require("supertest");
const { FakeRedis, unusedPort } = require("../helpers/fakeRedis");

// The Redis-backed store behind express-rate-limit, configured like the
// limiters in src/index.js and src/routes/candidates.js (issue #149): it
// limits while Redis answers, and failOpenLimiter lets requests through,
// quickly, while Redis is down or not answering. Uses the fake Redis; the
// scripts themselves are checked against a real one in
// rateLimitStoreRedis.test.js.

jest.setTimeout(20000);

let server;
let port;
let redis;
let createStore;
let consoleError;
let outageLog;
let connectionLog;
let failOpenLimiter;

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

function limitedApp(prefix, options = {}) {
  const app = express();
  app.use(failOpenLimiter({
    windowMs: 60 * 1000,
    max: 2,
    store: createStore(prefix),
    ...options,
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
      ({ outageLog } = createStore);
      connectionLog = require("../../src/redisConnectionLog");
      // From the same module registry, so its StoreError is the store's.
      ({ failOpenLimiter } = require("../../src/middleware/rateLimiter"));
    });
    process.env.REDIS_URL = "";
  });
});

beforeEach(async () => {
  // The store and the client log outages; keep them out of the test output.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  server = new FakeRedis("ok");
  await server.listen(port);
  await waitReady();
  // Both outage logs are shared module state: a test that left one failing,
  // or logged a line within the last minute, would hide the next test's
  // lines. Reset them, then forget anything logged before the test.
  outageLog.reset();
  connectionLog.reset();
  consoleError.mockClear();
});

afterEach(async () => {
  await server.stop();
  // Until the client sees the dropped connection it still reports ready, and
  // the next test's waitReady() would return before it has reconnected.
  for (let i = 0; i < 50 && redis.isReady; i++) await new Promise((r) => setTimeout(r, 20));
  if (redis.isReady) throw new Error("the Redis client didn't notice the dropped connection within 1 s");
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
    expect.stringMatching(/^Rate-limit store failing: .*without rate limiting/)
  );
});

// Issue #156: one stack trace per request filled the logs in an outage.
test("while Redis is down the outage is logged once, without a stack trace", async () => {
  const app = limitedApp("rl:mw:quiet:");
  await stopRedis();
  consoleError.mockClear();

  for (let i = 0; i < 20; i++) expect((await request(app).get("/")).status).toBe(200);

  const storeCalls = consoleError.mock.calls.filter(([first]) => /rate.?limit/i.test(String(first)));
  expect(storeCalls).toHaveLength(1);
  for (const args of consoleError.mock.calls) {
    for (const arg of args) expect(arg).not.toBeInstanceOf(Error);
  }
});

test("a request let through by a failing store carries no made-up rate-limit counts", async () => {
  const app = limitedApp("rl:mw:headers:", { standardHeaders: "draft-7" });
  await stopRedis();
  const res = await request(app).get("/");
  expect(res.status).toBe(200);
  expect(Object.keys(res.headers).filter((h) => /ratelimit/i.test(h))).toEqual([]);
});

test("the store's recovery is noted once Redis answers again", async () => {
  // The line itself may be held for up to a minute (src/outageLog.js, tested
  // in outageLog.test.js); the store has to report the success.
  const app = limitedApp("rl:mw:recover:");
  await stopRedis();
  expect((await request(app).get("/")).status).toBe(200);
  expect(outageLog.isFailing()).toBe(true);
  server = new FakeRedis("ok");
  await server.listen(port);
  await waitReady();
  expect((await request(app).get("/")).status).toBe(200);
  expect(outageLog.isFailing()).toBe(false);
});

test("the client's reconnect attempts are logged once, and the reconnect noted", async () => {
  await stopRedis();
  // node-redis retries with backoff; give it several attempts.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(connectionLog.isFailing()).toBe(true);
  const lines = consoleError.mock.calls.filter(([l]) => String(l).startsWith("Redis connection"));
  expect(lines).toEqual([[expect.stringMatching(/^Redis connection failing: /)]]);

  server = new FakeRedis("ok");
  await server.listen(port);
  await waitReady();
  expect(connectionLog.isFailing()).toBe(false);
});

test("the wrapper keeps the limiter's resetKey and getKey", async () => {
  const limiter = failOpenLimiter({
    windowMs: 60 * 1000,
    max: 1,
    store: createStore("rl:mw:methods:"),
    keyGenerator: () => "client",
  });
  const app = express();
  app.use(limiter);
  app.get("/", (req, res) => res.send("ok"));
  expect((await request(app).get("/")).status).toBe(200);
  expect((await request(app).get("/")).status).toBe(429);
  await limiter.resetKey("client");
  expect((await request(app).get("/")).status).toBe(200);
  // The store has no get(), so express-rate-limit's getKey throws; it is
  // still the limiter's own method.
  expect(typeof limiter.getKey).toBe("function");
});

test.each([
  ["a count of 0", "*2\r\n:0\r\n:60000\r\n"],
  ["no time left", "*2\r\n:1\r\n:-5\r\n"],
  ["a status string", "+OK\r\n"],
])("a reply with %s fails open quietly, not with a 500", async (_what, reply) => {
  server.reply = reply;
  server.mode = "odd";
  const app = limitedApp("rl:mw:bad:");
  expect((await request(app).get("/")).status).toBe(200);
  expect(consoleError.mock.calls.map(([l]) => l)).toEqual([
    expect.stringMatching(/^Rate-limit store failing: increment failed \(unexpected reply/),
  ]);
});

test("errors other than the store's still reach Express", async () => {
  const app = limitedApp("rl:mw:other:", {
    keyGenerator: () => {
      throw new Error("key generator broke");
    },
  });
  app.use((err, req, res, next) => res.status(500).send(err.message)); // eslint-disable-line no-unused-vars
  const res = await request(app).get("/");
  expect(res.status).toBe(500);
  expect(res.text).toBe("key generator broke");
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
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("decrement failed"));
});

test("a limiter that uncounts failed requests survives Redis going down mid-request", async () => {
  const app = express();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  app.use(failOpenLimiter({
    windowMs: 60 * 1000,
    max: 2,
    store: createStore("rl:mw:skip-failed:"),
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
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("decrement failed"));
});
