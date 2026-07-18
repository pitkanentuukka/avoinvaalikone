const { RedisStore } = require("rate-limit-redis");
const redis = require("../redis");

// Redis-backed rate-limit store when REDIS_URL is configured, so limits are
// shared across backend replicas. Returns undefined otherwise, which makes
// express-rate-limit fall back to its per-process MemoryStore (dev).
module.exports = (prefix) =>
  redis
    ? new RedisStore({ sendCommand: (...args) => redis.sendCommand(args), prefix })
    : undefined;
