const express = require("express");
const rateLimit = require("express-rate-limit");
const request = require("supertest");
const { FakeRedis } = require("../helpers/fakeRedis");

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

const waitReady = () =>
  redis.isReady ? Promise.resolve() : new Promise((resolve) => redis.once("ready", resolve));

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

beforeAll(async () => {
  server = new FakeRedis("ok");
  port = await server.listen(0);
  jest.isolateModules(() => {
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    redis = require("../../src/redis");
    createStore = require("../../src/middleware/rateLimitStore");
  });
  process.env.REDIS_URL = "";
  await waitReady();
});

beforeEach(() => {
  // express-rate-limit and src/redis.js log every store and connection error.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => consoleError.mockRestore());

afterAll(async () => {
  redis.destroy();
  await server.stop();
});

test("limits requests while Redis answers", async () => {
  const app = limitedApp("rl:mw:up:");
  expect((await request(app).get("/")).status).toBe(200);
  expect((await request(app).get("/")).status).toBe(200);
  expect((await request(app).get("/")).status).toBe(429);
});

test("lets requests through at once while Redis is down", async () => {
  const app = limitedApp("rl:mw:down:");
  await server.stop();
  // Let the client see the dropped connection.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  for (let i = 0; i < 3; i++) expect((await request(app).get("/")).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("allowing request without rate-limiting"),
    expect.anything()
  );
});

test("lets a request through within the store timeout while Redis doesn't answer", async () => {
  server = new FakeRedis("hang");
  await server.listen(port);
  await waitReady();
  const app = limitedApp("rl:mw:hang:");

  const started = Date.now();
  expect((await request(app).get("/")).status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2500);
});
