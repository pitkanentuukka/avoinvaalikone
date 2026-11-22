const rateLimit = require("express-rate-limit");
const { StoreError } = require("./rateLimitStore");

// An express-rate-limit limiter that fails *open*: when its store fails
// (Redis unreachable, not answering, or rejecting writes), the request goes
// through instead of 500ing. Losing shared rate limiting during a Redis
// outage is far better than dropping the voter-match endpoint on election
// night. Until Redis is back no limit applies at all: there is no
// per-process fallback then (only without REDIS_URL, in dev).
//
// This replaces express-rate-limit's passOnStoreError, which logs the store
// error with a full stack trace on every request (issue #156). Here the
// limiter passes the store's StoreError to next(), and the wrapper lets the
// request through; the store has already logged it through its outage log,
// once per minute at most. Any other error still reaches Express. As with
// passOnStoreError, a request let through gets no rate-limit headers or
// req.rateLimit: nothing that could pass for a real count.
function failOpenLimiter(options) {
  const limiter = rateLimit({ ...options, passOnStoreError: false });
  const failOpen = (req, res, next) =>
    limiter(req, res, (err) => (err instanceof StoreError ? next() : next(err)));
  // Keep the limiter's own methods reachable through the wrapper.
  return Object.assign(failOpen, { resetKey: limiter.resetKey, getKey: limiter.getKey });
}

// A positive safe integer from the environment, or the fallback. Compose
// passes an unset variable as "", which also means the fallback; anything
// else invalid warns at startup.
function limitFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // Rejects partial parses ("300/min"), fractions and unsafe/overflowed values.
  if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  console.warn(`${name} must be a positive safe integer; falling back to ${fallback}`);
  return fallback;
}

module.exports = { failOpenLimiter, limitFromEnv };
