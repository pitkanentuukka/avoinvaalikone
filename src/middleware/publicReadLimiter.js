const { failOpenLimiter, limitFromEnv } = require("./rateLimiter");
const redisStore = require("./rateLimitStore");

// Per-client limit on the failed public reads (GET /api/candidates,
// /api/candidates/:id, /api/question-sets) that reach the database (issue
// #158). What it bounds is a client walking URLs no cache holds, e.g. random
// candidate UUIDs: each is a new URL to Cloudflare, and its 404 isn't kept by
// the micro-cache (which keeps only 200s), so each was a database read.
//
// - Mounted after microCache(), so micro-cache hits, nearly all origin
//   traffic for these routes, never reach it.
// - Successful reads aren't counted (skipSuccessfulRequests): the micro-cache
//   already bounds them to about one database read per resource per replica
//   per minute, and counting them could throttle a carrier CGNAT crowd on a
//   cold edge cache. So legitimate voters practically never meet it; one
//   client at the default cap is 5 sub-ms primary-key lookups a second.
// - No rate-limit headers (legacyHeaders off): publicCache() has already
//   marked these responses public, so Cloudflare would replay one client's
//   counter to every visitor.
//
// It limits per address, as a Cloudflare per-IP rule would; a flood spread
// over many addresses isn't bounded by either (docs/scaling.md).
module.exports = failOpenLimiter({
  // The policy name (only sent in draft-8 RateLimit-Policy headers, which
  // are off); tests/unit/matchRateLimit.test.js finds the limiters by it.
  identifier: "public-read",
  windowMs: 60 * 1000,
  max: limitFromEnv("RATE_LIMIT_PUBLIC_READ_MAX", 300),
  skipSuccessfulRequests: true,
  legacyHeaders: false,
  standardHeaders: false,
  skip: () => process.env.NODE_ENV !== "production",
  store: redisStore("rl:public:"),
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  // no-store: publicCache() has already marked the response cacheable
  // (s-maxage=300), and Cloudflare could keep one client's 429 and serve it
  // to every visitor of that URL. Retry-After by hand, as the library only
  // sets it along with the rate-limit headers.
  handler: (req, res, next, options) => {
    const resetTime = req.rateLimit?.resetTime;
    const seconds = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 1000) : options.windowMs / 1000;
    res.set("Cache-Control", "no-store");
    res.set("Retry-After", String(Math.max(1, seconds)));
    res.status(options.statusCode).json(options.message);
  },
});
