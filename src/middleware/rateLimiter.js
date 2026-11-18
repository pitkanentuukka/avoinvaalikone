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
  return (req, res, next) =>
    limiter(req, res, (err) => (err instanceof StoreError ? next() : next(err)));
}

module.exports = { failOpenLimiter };
