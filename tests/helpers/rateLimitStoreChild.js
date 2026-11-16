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

async function increment() {
  const started = Date.now();
  try {
    const { totalHits } = await store.increment("client");
    return { ok: true, totalHits, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}`, ms: Date.now() - started };
  }
}

const ops = {
  increment,
  // An increment held up by a busy event loop (a GC pause, a CPU-heavy
  // request, a flood) for ms, though Redis answers at once.
  stalled: async ({ ms }) => {
    const result = increment();
    const until = Date.now() + ms;
    while (Date.now() < until);
    return result;
  },
  burst: ({ count }) => Promise.all(Array.from({ length: count }, increment)),
};

process.on("message", async ({ id, op = "increment", ...args }) => {
  process.send({ id, result: await ops[op](args) });
});

process.send({ ready: true });
