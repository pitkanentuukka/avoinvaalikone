// Per-process micro-cache for the public GET endpoints. Cloudflare absorbs
// almost all of this traffic; this cache is insurance for cache misses,
// purges, or a misconfigured edge rule. 60s staleness per replica sits well
// inside the 300s edge TTL already accepted, so there is no cross-replica
// invalidation.
//
// Memory is bounded by entry count and by the bytes of the retained bodies,
// and expired entries are dropped rather than left until evicted (issue #150).
const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;
// The full candidate list (~2,500 candidates with 1,000-character bios) is a
// few MB, so this leaves room for it plus hundreds of single candidates.
const MAX_BYTES = 32 * 1024 * 1024;

// One key per resource, not per URL: the cached endpoints ignore the query
// string, so it is left out, and the key is built from the route as declared
// (req.route.path) rather than as spelled, so "/api/candidates/",
// "/API/Candidates" and "/api/candidates?x=1" share an entry. Param values are
// lowercased because every cached route's params are UUIDs, which Postgres
// matches case-insensitively (validateUUIDParam runs first); a route with a
// case-sensitive param must not be cached with this key. The mount path is
// lowercased because the app keeps Express's default case-insensitive routing.
function cacheKey(req) {
  const params = Object.keys(req.params)
    .sort()
    .map((name) => [name, String(req.params[name]).toLowerCase()]);
  return JSON.stringify([req.baseUrl.toLowerCase(), req.route.path, params]);
}

function createMicroCache({ maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  // Bodies are kept as Buffers so their size is exactly what is counted: a
  // JS string holding any non-Latin-1 character (an en dash or emoji in one
  // bio) takes two bytes per character, double its UTF-8 length.
  const store = new Map(); // key -> { body: Buffer, expires }, oldest first
  let totalBytes = 0;

  function remove(key) {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    totalBytes -= entry.body.length;
  }

  function put(key, json, ttlMs) {
    remove(key); // re-inserting moves the key to the newest position
    const body = Buffer.from(json);
    const bytes = body.length;
    if (bytes > maxBytes) return;
    const now = Date.now();
    for (const [k, entry] of store) {
      if (entry.expires <= now) remove(k);
    }
    while (store.size > 0 && (store.size >= maxEntries || totalBytes + bytes > maxBytes)) {
      remove(store.keys().next().value);
    }
    if (store.size >= maxEntries) return;
    store.set(key, { body, expires: now + ttlMs });
    totalBytes += bytes;
  }

  const microCache = (ttlMs = DEFAULT_TTL_MS) => (req, res, next) => {
    // Production only, like the rate limiters: in dev/tests a 60s stale window
    // hides writes from the very person making them.
    if (process.env.NODE_ENV !== "production") return next();
    // Only reads are cached. Without req.route (mounted with router.use()
    // instead of on a route) there is no declared path to key on, and the
    // raw path would let spelling variants multiply entries again, so such a
    // mount passes requests through uncached.
    if ((req.method !== "GET" && req.method !== "HEAD") || !req.route) return next();
    const key = cacheKey(req);
    const hit = store.get(key);
    if (hit) {
      if (hit.expires > Date.now()) {
        return res.set("X-Micro-Cache", "HIT").type("json").send(hit.body);
      }
      remove(key);
    }

    const json = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode === 200) put(key, JSON.stringify(data), ttlMs);
      return json(data);
    };
    next();
  };

  microCache.stats = () => ({ entries: store.size, bytes: totalBytes });
  return microCache;
}

module.exports = createMicroCache();
module.exports.createMicroCache = createMicroCache;
