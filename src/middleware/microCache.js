// Per-process micro-cache for the public GET endpoints. Cloudflare absorbs
// almost all of this traffic; this cache is insurance for cache misses,
// purges, or a misconfigured edge rule. 60s staleness per replica sits well
// inside the 300s edge TTL already accepted, so there is no cross-replica
// invalidation.
//
// Memory is bounded by entry count and by the bytes of the retained bodies,
// and expired entries are dropped rather than left until evicted (issue #150).
// When a bound is hit, the least recently used entry goes first, so a walk
// over many candidate pages can't push out the list everyone reads (#160).
const DEFAULT_TTL_MS = 60_000;
// Room for every one of the ~2,500 public candidate pages, twice over, plus
// the list and the question sets: the cap must not be below the number of
// distinct cacheable URLs, or a cyclic walk over them never hits.
const MAX_ENTRIES = 5000;
// The full candidate list (~2,500 candidates with 1,000-character bios) is a
// few MB. A candidate page is a few KB, but with long answer explanations
// (up to 500 characters each) on every question all of them may not fit; the
// budget then decides, and LRU keeps the ones being read.
const MAX_BYTES = 32 * 1024 * 1024;

// One key per resource, not per URL: the cached endpoints ignore the query
// string, so it is left out, and the key is built from the route as declared
// (req.route.path) rather than as spelled, so "/api/candidates/",
// "/API/Candidates" and "/api/candidates?x=1" share an entry. Param values are
// lowercased because every cached route's params are UUIDs, which Postgres
// matches case-insensitively (validateUUIDParam runs first); a route with a
// case-sensitive param, or a handler that reads req.query, must not be cached
// with this key. The mount path is lowercased because the app keeps Express's
// default case-insensitive routing.
function cacheKey(req) {
  const params = Object.keys(req.params)
    .sort()
    .map((name) => [name, String(req.params[name]).toLowerCase()]);
  return JSON.stringify([req.baseUrl.toLowerCase(), req.route.path, params]);
}

function createMicroCache({ maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  // Bodies are kept as Buffers of their own so the counted size is what is
  // held: a JS string holding any non-Latin-1 character (an en dash or emoji
  // in one bio) takes two bytes per character, double its UTF-8 length, and
  // Buffer.from() would put a small body in a shared 8 KiB pool slab.
  // A Map iterates in insertion order; a hit re-inserts its key, so the
  // first key is always the least recently used.
  const store = new Map(); // key -> { body: Buffer, expires }
  let totalBytes = 0;

  function remove(key) {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    totalBytes -= entry.body.length;
  }

  function put(key, json, ttlMs) {
    remove(key); // re-inserting moves the key to the newest position
    const bytes = Buffer.byteLength(json);
    if (bytes > maxBytes) return;
    const body = Buffer.allocUnsafeSlow(bytes);
    body.write(json);
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
    // Only reads are cached. Without a declared string path (mounted with
    // router.use(), or on a RegExp or array route) there is nothing to key
    // on: the raw path would let spelling variants multiply entries again,
    // and a RegExp or array would make distinct paths share one, so such a
    // mount passes requests through uncached.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (typeof req.route?.path !== "string") return next();
    const key = cacheKey(req);
    const hit = store.get(key);
    if (hit) {
      if (hit.expires > Date.now()) {
        store.delete(key);
        store.set(key, hit);
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
