const { failOpenLimiter, limitFromEnv } = require("./rateLimiter");
const redisStore = require("./rateLimitStore");

// Per-client limit on the public reads (GET /api/candidates,
// /api/candidates/:id, /api/question-sets) that reach the database (issue
// #158). Mounted after microCache(), so micro-cache hits, nearly all origin
// traffic for these routes, are never counted; Cloudflare answers most of
// the rest before it gets here. What it bounds is a client walking URLs no
// cache holds, e.g. random candidate UUIDs: each is a 404 (not cached) and a
// new URL to Cloudflare, so each was a database read.
//
// Only misses count, so the default is loose: a carrier CGNAT address with
// many voters on a cold cache (right after a deploy or purge) can cause
// hundreds a minute legitimately, and one client at the cap is 20 sub-ms
// primary-key lookups a second. A flood from many addresses needs the
// Cloudflare rate-limiting rule in docs/scaling.md.
module.exports = failOpenLimiter({
  identifier: "public-read",
  windowMs: 60 * 1000,
  max: limitFromEnv("RATE_LIMIT_PUBLIC_READ_MAX", 1200),
  skip: () => process.env.NODE_ENV !== "production",
  store: redisStore("rl:public:"),
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  // publicCache() has already marked the response cacheable (s-maxage=300)
  // before this runs: without no-store, Cloudflare could keep one client's
  // 429 and serve it to every visitor of that URL.
  handler: (req, res, next, options) => {
    res.set("Cache-Control", "no-store");
    res.status(options.statusCode).json(options.message);
  },
});
