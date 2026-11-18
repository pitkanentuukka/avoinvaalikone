// Optional Redis client, used as a shared store for rate limiting so limits
// are enforced across backend replicas. When REDIS_URL is unset (local dev
// without compose), callers fall back to per-process behavior.
const { createClient } = require("redis");
const connectionLog = require("./redisConnectionLog");

let client = null;

if (process.env.REDIS_URL) {
  client = createClient({
    url: process.env.REDIS_URL,
    // The rate limiters fail open on store errors, so while disconnected
    // reject commands at once instead of queueing them until node-redis's
    // 5 s command timeout: in an outage every limited request would wait it
    // out first (issue #149).
    disableOfflineQueue: true,
    // Caps commands sent to a Redis that has stopped answering, which wait
    // for a reply even after src/middleware/rateLimitStore.js has given up on
    // them; past the cap new commands fail at once instead of each waiting
    // out the store's timeout. A responsive Redis has only a handful in
    // flight even on election night.
    commandsQueueMaxLength: 1000,
    // The default reconnect strategy retries with backoff (at most ~2.2 s
    // apart) and never gives up, except after a socketTimeout, unset here.
  });
  // An error is emitted for each reconnect attempt, ~2 s apart while Redis
  // is down: log the outage, then at most a line a minute, including the
  // reconnect, not every attempt (issue #156).
  client.on("error", (err) => connectionLog.failure(err.message));
  client.on("ready", () => connectionLog.recovered());
  client.connect().catch((err) => console.error("Redis connect failed:", err.message));
}

module.exports = client;
