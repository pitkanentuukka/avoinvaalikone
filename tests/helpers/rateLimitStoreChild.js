// Child process for tests/unit/redisRateLimitStore.test.js: creates a real
// Redis-backed rate-limit store against REDIS_URL and runs increments on
// request from the parent over IPC.
//
// It runs in its own process because the failure under test is Node exiting
// on an unhandled rejection (issue #149), which inside a Jest worker would be
// swallowed or take the worker down; here it shows up as this process exiting.

const createStore = require("../../src/middleware/rateLimitStore");

const store = createStore("rl:test:");
// express-rate-limit calls init() when the limiter is created.
store.init({ windowMs: 60 * 1000 });

process.on("message", async ({ id }) => {
  const started = Date.now();
  try {
    const { totalHits } = await store.increment("client");
    process.send({ id, ok: true, totalHits, ms: Date.now() - started });
  } catch (err) {
    process.send({ id, ok: false, error: `${err.name}: ${err.message}`, ms: Date.now() - started });
  }
});

process.send({ ready: true });
