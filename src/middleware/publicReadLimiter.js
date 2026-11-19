const { failOpenLimiter, limitFromEnv } = require("./rateLimiter");
const redisStore = require("./rateLimitStore");

// Per-client limits on the public reads that reach the database (issue
// #158). Both are mounted after microCache(), so micro-cache hits, nearly all
// origin traffic for these routes, never reach them.
//
// - Candidate pages (GET /api/candidates/:id): every miss counts, whatever
//   its status. There are ~2,500 public ids, more than the micro-cache can be
//   relied on to hold, and each id (or ?x=… spelling of it) is a new URL to
//   Cloudflare, so a client walking ids, existing or random, would otherwise
//   cost a database read (two for an existing one) per request. The cap is
//   loose: a carrier CGNAT address with many voters opening candidates on a
//   cold cache can cause hundreds of misses a minute legitimately.
// - The lists (GET /api/candidates, /api/question-sets): only failed reads
//   (status >= 400) count. Each is one resource, so the micro-cache bounds
//   its successful reads to one per replica per minute, and a CGNAT crowd on
//   a cold edge must never be throttled out of the quiz. (Successes count
//   while in flight; concurrent misses aren't coalesced yet, #181.)
//
// Neither sends rate-limit headers: publicCache() has already marked these
// responses public, so Cloudflare would replay one client's counter to every
// visitor. They limit per address, as a Cloudflare per-IP rule would; a flood
// spread over many addresses isn't bounded by either (docs/scaling.md).

const common = {
  windowMs: 60 * 1000,
  legacyHeaders: false,
  standardHeaders: false,
  skip: () => process.env.NODE_ENV !== "production",
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
};

module.exports = {
  candidateReads: failOpenLimiter({
    ...common,
    max: limitFromEnv("RATE_LIMIT_CANDIDATE_READ_MAX", 1200),
    store: redisStore("rl:candidate:"),
  }),
  listReads: failOpenLimiter({
    ...common,
    max: limitFromEnv("RATE_LIMIT_LIST_READ_MAX", 300),
    skipSuccessfulRequests: true,
    store: redisStore("rl:list:"),
  }),
};
