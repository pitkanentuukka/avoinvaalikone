// The rate-limit store's Lua scripts against a real Redis (issue #149). The
// other store tests use tests/helpers/fakeRedis.js, which only tells the
// scripts apart and can't check what they do: PTTL's -2 (no key) and -1 (no
// expiry), window expiry, DECREMENT's guard, and whether the SHA the store
// computes is the one Redis computes (or every call would cost a NOSCRIPT
// round trip and an EVAL).
//
// Runs when REDIS_TEST_URL is set, e.g. against the compose Redis:
//   REDIS_TEST_URL=redis://localhost:6379 npm test -- rateLimitStoreRedis
// CI runs it in the e2e-api job, which has a Redis service.

// REQUIRE_REDIS_TEST (set in CI) turns a missing REDIS_TEST_URL into a
// failure, so a renamed variable can't make the CI step pass as "skipped".
if (process.env.REQUIRE_REDIS_TEST && !process.env.REDIS_TEST_URL) {
  throw new Error("REQUIRE_REDIS_TEST is set but REDIS_TEST_URL is not");
}

const describeWithRedis = process.env.REDIS_TEST_URL ? describe : describe.skip;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describeWithRedis("rate-limit store scripts on a real Redis (#149)", () => {
  // Unique per run, so parallel runs and a developer's own keys don't mix.
  const prefix = `rl:jest:${process.pid}:${Date.now()}:`;
  let redis;
  let createStore;

  const store = (windowMs = 60 * 1000) => {
    const s = createStore(prefix);
    s.init({ windowMs });
    return s;
  };

  const noscriptErrors = async () => {
    const info = await redis.sendCommand(["INFO", "errorstats"]);
    return Number(/errorstat_NOSCRIPT:count=(\d+)/.exec(info)?.[1] ?? 0);
  };

  beforeAll(async () => {
    jest.isolateModules(() => {
      process.env.REDIS_URL = process.env.REDIS_TEST_URL;
      redis = require("../../src/redis");
      createStore = require("../../src/middleware/rateLimitStore");
    });
    process.env.REDIS_URL = "";
    if (!redis.isReady) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no Redis at REDIS_TEST_URL (${process.env.REDIS_TEST_URL})`)),
          // Under Jest's 5 s hook timeout, so this message is what shows.
          3000
        );
        redis.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  afterAll(async () => {
    // destroy() even when Redis is gone, or its reconnect loop keeps Jest
    // from exiting.
    try {
      if (redis.isReady) {
        const keys = await redis.sendCommand(["KEYS", `${prefix}*`]);
        if (keys.length) await redis.sendCommand(["DEL", ...keys]);
      }
    } finally {
      redis.destroy();
    }
  });

  test("the first hit starts a window and later hits count within it", async () => {
    const s = store();
    const before = Date.now();
    const first = await s.increment("count");
    expect(first.totalHits).toBe(1);
    expect(first.resetTime.getTime()).toBeGreaterThanOrEqual(before + 60 * 1000 - 50);
    expect(first.resetTime.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 1000);

    const second = await s.increment("count");
    expect(second.totalHits).toBe(2);
    expect(second.resetTime.getTime()).toBeLessThanOrEqual(first.resetTime.getTime() + 50);
  });

  test("the hash the store sends is the one Redis computes for the script", async () => {
    // After a flush the first call gets NOSCRIPT and EVALs the source, which
    // caches it under Redis's hash; later calls must then hit that cache.
    await redis.sendCommand(["SCRIPT", "FLUSH"]);
    const s = store();
    const before = await noscriptErrors();
    await s.increment("sha");
    const afterFirst = await noscriptErrors();
    // The store did send EVALSHA, and fell back to EVAL.
    expect(afterFirst).toBe(before + 1);
    await s.increment("sha");
    await s.increment("sha");
    expect(await noscriptErrors()).toBe(afterFirst);
  });

  test("a window that has expired starts again at 1", async () => {
    const s = store(100);
    expect((await s.increment("expiry")).totalHits).toBe(1);
    expect((await s.increment("expiry")).totalHits).toBe(2);
    await sleep(150);
    expect((await s.increment("expiry")).totalHits).toBe(1);
  });

  test("a counter without an expiry is replaced by a fresh window", async () => {
    await redis.sendCommand(["SET", `${prefix}no-ttl`, "5"]);
    const s = store();
    expect((await s.increment("no-ttl")).totalHits).toBe(1);
    const ttl = Number(await redis.sendCommand(["PTTL", `${prefix}no-ttl`]));
    expect(ttl).toBeGreaterThan(0);
  });

  test("decrement lowers a live counter and doesn't create a missing one", async () => {
    const s = store();
    await s.increment("dec");
    await s.increment("dec");
    await s.decrement("dec");
    expect((await s.increment("dec")).totalHits).toBe(2);

    await s.decrement("dec-missing");
    expect(Number(await redis.sendCommand(["EXISTS", `${prefix}dec-missing`]))).toBe(0);
  });

  // A hit counted in one window and uncounted after the next began (a slow
  // successful read under skipSuccessfulRequests) must not take the new
  // window's counter below 0.
  test("decrement never takes a counter below 0", async () => {
    const s = store();
    await s.increment("floor");
    await s.decrement("floor");
    await s.decrement("floor");
    await s.decrement("floor");
    expect(Number(await redis.sendCommand(["GET", `${prefix}floor`]))).toBe(0);
    expect((await s.increment("floor")).totalHits).toBe(1);
  });

  test("resetKey starts the client's count again", async () => {
    const s = store();
    await s.increment("reset");
    await s.increment("reset");
    await s.resetKey("reset");
    expect((await s.increment("reset")).totalHits).toBe(1);
  });
});
