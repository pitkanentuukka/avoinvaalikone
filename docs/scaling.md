# Election-day scaling guide

This document describes the changes made to support ~500 req/s peak traffic on
election day, the deployment steps required to activate edge caching, and how
to validate the setup with a load test.

For the next step beyond this (~5,000 req/s), see the unimplemented plan in
[scaling-10x.md](scaling-10x.md).

---

## Architecture overview

A voter session makes two requests to the origin:

1. `GET /api/question-sets` — fetches all approved question sets with their
   questions (~1 MB JSON). Fully cacheable; static while polls are open.
2. `POST /api/voter/match` — submits answers, receives ranked candidates.
   Uncacheable (per-voter input). This is the only real origin load.

After the changes below, Cloudflare absorbs nearly all GET traffic (one edge
hit per datacolo per TTL cycle). The origin only processes match POSTs, spread
across 3 Node processes.

---

## What was changed (2026-06-12)

### Edge/HTTP caching

| File | Change |
|------|--------|
| `src/middleware/cacheControl.js` | New — `publicCache(sMaxage)` and `noStore` helpers |
| `src/routes/questionSets.js` | `GET /api/question-sets` → `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600` + micro-cache |
| `src/routes/candidates.js` | `GET /api/candidates` and `GET /api/candidates/:id` → same headers + micro-cache; party-token routes → `no-store` |
| `src/index.js` | Admin routes → `no-store` |

Express emits weak ETags on `res.json` by default, so browser 304 revalidation
works automatically.

Staleness window: up to ~5 min (s-maxage) + stale-while-revalidate. Manual
escape hatch: Cloudflare dashboard → Caching → Purge by URL.

### In-process micro-cache

`src/middleware/microCache.js` — 60-second per-replica in-memory cache for the
three public GET endpoints (production-only). Insurance against Cloudflare cache
misses, purges, or a misconfigured edge rule. Returns `X-Micro-Cache: HIT` on
hits. No cross-replica invalidation needed; 60 s sits within the accepted edge
staleness window.

### Compression

`vaalikone-frontend/nginx.conf` — added `gzip_proxied any; gzip_comp_level 5;
gzip_min_length 1024; gzip_vary on;`. Previously `gzip_proxied` defaulted to
`off`, which skips compression on responses to requests with a `Via` header —
i.e. everything that arrives through Caddy/Cloudflare in production.

### Match endpoint

`src/routes/voter.js`:

- **Slim payload** — `ca.explanation` removed from the candidate-answers `SELECT`
  and from the match response. Per-candidate answers are now `{ value }` only.
  Cuts the response from 500 KB–2 MB down to ~50–100 KB.
- **Lazy explanations in the UI** (`vaalikone-frontend/src/App.jsx`) — on first
  expand of a result card, `GET /api/candidates/:id` is fetched (edge-cached,
  returns full answers with explanations) and merged into a `candidateDetails`
  state map.
- **Fire-and-forget research insert** — `crypto.randomUUID()` replaces the
  `SELECT gen_random_uuid()` DB roundtrip; the INSERT is not awaited (logged on
  error). The match response is returned immediately. Accepted trade-off:
  anonymous research rows lost on crash.
- **Covering index** `migrations/010_match_covering_index.sql` —
  `(question_id, candidate_id) INCLUDE (value)` enables index-only scans on the
  match query now that `explanation` is out of the SELECT.

### Redis rate limiting

`src/redis.js` + `src/middleware/rateLimitStore.js` + deps `redis`,
`rate-limit-redis`:

- All three rate limiters (admin, submission, match) share a Redis store when
  `REDIS_URL` is set, so limits are enforced across backend replicas.
- Falls back to per-process in-memory store when `REDIS_URL` is unset (local
  dev without compose).
- **Match limit raised 60 → 300 req/min/IP**. Finnish carriers (DNA/Elisa/Telia)
  CGNAT heavily; one IP can represent hundreds of simultaneous voters. 300/min
  still caps a single abuser at 5 req/s. Adjustable via `RATE_LIMIT_MATCH_MAX`.

### Backend replicas

`docker-compose.prod.yml` — `deploy: replicas: 3` on the backend service.
3 replicas × 10 pool connections = 30 DB connections (well under Postgres
`max_connections` default of 100). Replica count should approximate vCPU count
on the server (`nproc`).

`migrations/run.js` — advisory lock (`pg_advisory_lock(727274)`) acquired
before bootstrap table creation and the migration loop. Replicas block on the
lock, then skip migrations already applied. **Must be deployed before or
together with `replicas: 3`.**

`docker-compose.yml` — removed `container_name: vaalikone-backend` (a fixed
container name is incompatible with replicas).

`vaalikone-frontend/nginx.conf` — added Docker embedded-DNS resolver and
`set $backend_upstream http://backend:3000` so nginx re-resolves the backend
hostname every 10 seconds. Without this, nginx pins the IPs at startup and
502s after replica restarts.

`src/db/pool.js` — pool max is now `PG_POOL_MAX` env var (default 10).

### Compose hygiene

`docker-compose.yml`:

- Redis service (`redis:7-alpine`, 64 MB cap, `noeviction`, no persistence).
- Postgres `shared_buffers=256MB`, `effective_cache_size=768MB`,
  `log_min_duration_statement=250`.
- Log rotation on every service: `json-file` driver, 10 MB max, 3 files.
  Without this, sustained traffic fills the disk overnight.

### Observability

- `src/index.js` — morgan skips successful requests in production
  (`res.statusCode < 400`). Per-request logging at election-day rates is
  measurable event-loop and disk overhead.
- `src/db/pool.js` — 30-second interval warns on pool saturation
  (`waitingCount > 0`); queries >500 ms are logged with the first 80 chars of
  SQL.
- `/api/health` — now returns `{ status, pool: { total, idle, waiting } }`.
  Free visibility via `curl https://avoinvaalikone.fi/api/health` during the
  event; no DB roundtrip so Docker/CI probes stay cheap.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | _(unset)_ | Redis connection string. Required for shared rate limiting across replicas. Set automatically in compose. |
| `PG_POOL_MAX` | `10` | DB connections per backend process. `replicas × PG_POOL_MAX` must stay under Postgres `max_connections` (100). |
| `RATE_LIMIT_MATCH_MAX` | `300` | Match requests per IP per minute. Raise for load testing in prod mode; lower is more conservative against abuse. |

---

## Deployment steps

These steps apply on first deploy after the scaling work. Subsequent deploys
via CI/CD (rsync + `docker compose up --build`) are automatic.

### 1. Deploy the code

CI/CD handles this on push to `main`. If deploying manually:

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  ./ user@80.69.172.220:/opt/vaalikone/
ssh user@80.69.172.220 "cd /opt/vaalikone && \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d"
```

### 2. Verify replicas are up

```bash
ssh user@80.69.172.220 "docker compose -f docker-compose.yml -f docker-compose.prod.yml ps"
# Expect: 3 backend containers all healthy
```

Confirm migrations ran on exactly one replica (others skipped):

```bash
ssh user@80.69.172.220 "docker compose logs backend 2>&1 | grep -E '010|already applied'"
# backend-1: ✓ Migration 010_match_covering_index.sql applied successfully
# backend-2:   Migration 010_match_covering_index.sql already applied, skipping
# backend-3:   Migration 010_match_covering_index.sql already applied, skipping
```

### 3. Create the Cloudflare Cache Rule (one-time manual step)

**This is required.** Cloudflare does not cache `application/json` by default.

1. Log in to the Cloudflare dashboard → select the `avoinvaalikone.fi` zone.
2. Go to **Caching → Cache Rules → Create rule**.
3. Configure:
   - **Rule name:** `Cache public API GETs`
   - **Match:** Custom filter expression:
     ```
     (http.host eq "avoinvaalikone.fi") and
     (starts_with(http.request.uri.path, "/api/question-sets") or
      starts_with(http.request.uri.path, "/api/candidates"))
     ```
   - **Cache eligibility:** Eligible for cache
   - **Edge TTL:** Respect origin headers
4. Save and deploy the rule.

**Safety:** The rule only caches responses where the origin sends
`Cache-Control: public, s-maxage=...`. Party-token and admin routes send
`no-store`, and POST requests are never cached by Cloudflare.

### 4. Verify edge caching

```bash
# First request — populates Cloudflare edge cache
curl -sI https://avoinvaalikone.fi/api/question-sets | grep cf-cache-status
# cf-cache-status: MISS  (or HIT if another colo already cached it)

# Second request — served from edge
curl -sI https://avoinvaalikone.fi/api/question-sets | grep cf-cache-status
# cf-cache-status: HIT

# Party-token route must NOT be cached
curl -sI https://avoinvaalikone.fi/api/candidates/party/some-token | grep cf-cache-status
# cf-cache-status: DYNAMIC  (or BYPASS)

# Match POST must never be cached
curl -sI -X POST https://avoinvaalikone.fi/api/voter/match | grep cf-cache-status
# cf-cache-status: DYNAMIC
```

### 5. Check cache headers and gzip on origin

```bash
# Cache-Control header present
curl -sI https://avoinvaalikone.fi/api/question-sets | grep -i cache-control
# Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600

# Gzip active (Cloudflare may upgrade to Brotli; verify at origin via Caddy)
curl -sI -H "Accept-Encoding: gzip" https://avoinvaalikone.fi/api/question-sets | grep -i content-encoding
# content-encoding: gzip  (or br if Cloudflare serves Brotli)
```

### 6. Check pool / health endpoint

```bash
curl -s https://avoinvaalikone.fi/api/health | python3 -m json.tool
# {
#   "status": "ok",
#   "timestamp": "...",
#   "pool": { "total": 3, "idle": 3, "waiting": 0 }
# }
```

`waiting > 0` during the event means the pool is saturated — raise `PG_POOL_MAX`
or add a replica.

---

## Load testing

See `scripts/loadtest/README.md` for full instructions.

Quick reference:

```bash
# On the server, against localhost (bypasses Cloudflare — measures origin only)
RATE_LIMIT_MATCH_MAX=100000 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend  # disable rate limit for test
k6 run -e BASE_URL=http://localhost scripts/loadtest/voter-flow.js
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend  # afterwards: back to the .env value
```

Thresholds in the script:

- Error rate < 1 %
- `GET /api/question-sets` p95 < 300 ms
- `POST /api/voter/match` p95 < 800 ms
- `GET /api/candidates/:id` p95 < 300 ms

**Never load-test through `https://avoinvaalikone.fi`** — you measure
Cloudflare's cache, not the origin, and high synthetic traffic can trip
Cloudflare's DDoS/bot mitigation against your own IP.

---

## Election-night checklist

- [ ] Cache Rule active in Cloudflare (verify `cf-cache-status: HIT`)
- [ ] 3 backend replicas healthy (`docker compose ps`)
- [ ] Redis healthy (`docker compose exec redis redis-cli ping`)
- [ ] `RATE_LIMIT_MATCH_MAX` set appropriately (raise if CGNAT complaints)
- [ ] Disk space adequate (`df -h /`) — log rotation limits logs to 3×10 MB per service
- [ ] Health endpoint polled manually: `pool.waiting` should stay 0
- [ ] Cloudflare analytics show cache hit ratio >90% for GET traffic
- [ ] Manual CF purge bookmarked for emergency staleness clears

## Emergency knobs

| Situation | Action |
|-----------|--------|
| Admin approves/hides a question set and it needs to be visible immediately | Cloudflare dashboard → Caching → Purge by URL → `https://avoinvaalikone.fi/api/question-sets` |
| Voters behind one carrier IP getting 429 | Raise `RATE_LIMIT_MATCH_MAX` in `.env`, then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend`. Keep both `-f` files (without the prod overlay this recreates a single backend with `TRUST_PROXY_HOPS=1`, which puts every voter in one rate-limit bucket, and publishes port 3000 past Caddy and Cloudflare), and don't use `restart`, which keeps the old environment. All replicas are recreated at once, so expect a few seconds of 502s (the match request retries once) |
| DB pool exhaustion (`waiting > 0`) | Raise `PG_POOL_MAX` in `.env` (keep `replicas × PG_POOL_MAX` under 100), then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend` |
| One backend replica unhealthy | `docker compose restart backend` — nginx re-resolves DNS within 10 s |
