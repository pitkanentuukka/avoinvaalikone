// Per-process micro-cache for the public GET endpoints. Cloudflare absorbs
// almost all of this traffic; this cache is insurance for cache misses,
// purges, or a misconfigured edge rule. 60s staleness per replica sits well
// inside the 300s edge TTL already accepted, so there is no cross-replica
// invalidation.
const store = new Map(); // originalUrl -> { body, expires }
const MAX_ENTRIES = 500;

module.exports = (ttlMs = 60_000) => (req, res, next) => {
  // Production only, like the rate limiters: in dev/tests a 60s stale window
  // hides writes from the very person making them.
  if (process.env.NODE_ENV !== "production") return next();
  const key = req.originalUrl;
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) {
    return res.set("X-Micro-Cache", "HIT").type("json").send(hit.body);
  }

  const json = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode === 200) {
      store.set(key, { body: JSON.stringify(data), expires: Date.now() + ttlMs });
      if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
    }
    return json(data);
  };
  next();
};
