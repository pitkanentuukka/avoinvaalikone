// Cache-Control helpers. The public GET endpoints are edge-cached by
// Cloudflare (a Cache Rule makes /api/question-sets and /api/candidates
// eligible, with Edge TTL "respect origin headers"), so these headers are
// what actually controls election-day cacheability.

// Shared caches (Cloudflare) hold the response for sMaxage seconds and may
// serve it stale while revalidating; browsers revalidate after 60s via the
// ETag Express already emits on res.json.
const publicCache = (sMaxage = 300) => (req, res, next) => {
  res.set(
    "Cache-Control",
    `public, max-age=60, s-maxage=${sMaxage}, stale-while-revalidate=600`
  );
  next();
};

// For tokened/admin responses: even if a broad edge cache rule matches the
// path, no-store keeps them out of every cache.
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

module.exports = { publicCache, noStore };
