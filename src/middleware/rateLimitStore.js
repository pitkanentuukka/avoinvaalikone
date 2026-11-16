const { RedisStore } = require("rate-limit-redis");
const redis = require("../redis");

// rate-limit-redis loads its Lua scripts when the store is constructed (and
// again after a failed EVALSHA), but only awaits a load when a request comes
// in. A load that failed before then — Redis down at startup, or answering
// LOADING after a restart — was an unhandled rejection, and Node exited
// (issue #149). Marking every load as handled is enough for recovery: the
// store keeps the rejected promise, so the next request's EVALSHA fails,
// reloads the script and retries, and the limiters' passOnStoreError lets
// requests through while that fails.
const handled = (promise) => {
  promise.catch(() => {});
  return promise;
};

// The limiters are in front of every API request, so a Redis problem must
// cost a request milliseconds, not seconds (issue #149); Redis runs next to
// the backend and normally answers in well under a millisecond. node-redis's
// own command timeout doesn't do this: it only covers a command still waiting
// to be written, and one already sent to a Redis that stopped answering waits
// for the reply indefinitely. A command that loses the race stays queued in
// node-redis until Redis answers or the connection drops, which
// commandsQueueMaxLength in src/redis.js bounds.
const COMMAND_TIMEOUT_MS = 500;

function sendCommand(...args) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS} ms`)),
      COMMAND_TIMEOUT_MS
    );
  });
  return Promise.race([redis.sendCommand(args), timeout]).finally(() => clearTimeout(timer));
}

class FailSafeRedisStore extends RedisStore {
  loadIncrementScript(key) {
    return handled(super.loadIncrementScript(key));
  }

  loadGetScript(key) {
    return handled(super.loadGetScript(key));
  }
}

// Redis-backed rate-limit store when REDIS_URL is configured, so limits are
// shared across backend replicas. Returns undefined otherwise, which makes
// express-rate-limit fall back to its per-process MemoryStore (dev).
module.exports = (prefix) =>
  redis
    ? new FailSafeRedisStore({ sendCommand, prefix })
    : undefined;
