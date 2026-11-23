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
staleness window. Entries are keyed by route and lowercased UUID param, not the
raw URL, so query strings and path spelling variants can't multiply copies;
retained bodies are capped at 5,000 entries (room for every candidate page)
and 32 MiB per replica (pages with long answer explanations may not all fit),
evicting the least recently used entry first.

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

`src/redis.js` + `src/middleware/rateLimitStore.js` + dep `redis`:

- All eight rate limiters (admin, submission, match, the party, registration
  and candidate-token routes in `src/routes/candidates.js`, and the two for
  public reads) share a Redis store when `REDIS_URL` is set, so limits are
  enforced across backend replicas. The token-route limits are 60, 100 and
  300 requests per 15 minutes per IP, respectively. The public-read limiters
  (`src/middleware/publicReadLimiter.js`) are mounted after the micro-cache,
  so they count only reads that reach the database: every candidate-page
  miss (1200 per minute per IP by default; there are more ids than the
  micro-cache can be relied on to hold), and only failed reads (status
  ≥ 400, 300 per minute) of the candidate list and the question sets, whose
  successful reads the micro-cache bounds. Without them, a client walking
  candidate ids (random ones are 404s the micro-cache doesn't keep, and each
  id is a new URL to Cloudflare) cost a database read per request (#158).
  All eight limiters apply only when `NODE_ENV=production`.
- "Per IP" means per client address (`req.ip`), except that IPv6 addresses
  are grouped by /56 (`failOpenLimiter()` in `src/middleware/rateLimiter.js`,
  #182). One IPv6 host has at least a /64 of addresses and usually a /56, so
  keying on the full address let a single host rotate past every limit and
  fill Redis with a key per address. A /56 is at most 256 subscribers' /64s,
  far fewer voters than one carrier CGNAT IPv4 address, which the limits
  already allow for. An IPv4-mapped address (`::ffff:a.b.c.d`) counts as the
  plain IPv4 address.
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
- `/api/health` — returns `{ status, timestamp }`, plus
  `pool: { total, idle, waiting }` when called with the admin token
  (`Authorization: Bearer $ADMIN_SECRET`). Free visibility during the event; no
  DB roundtrip so Docker/CI probes stay cheap. A request with an
  `Authorization` header that isn't the admin token counts toward the admin
  rate limit (30 / 15 min per IP, shared with `/api/admin/*`) and gets 429
  after that, so don't point a monitor at it with a stale token.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | _(unset)_ | Redis connection string. Required for shared rate limiting across replicas. Set automatically in compose. |
| `PG_POOL_MAX` | `10` | DB connections per backend process. `replicas × PG_POOL_MAX` must stay under Postgres `max_connections` (100). |
| `RATE_LIMIT_CANDIDATE_READ_MAX` | `1200` | Candidate-page reads (`/api/candidates/<id>`) per IP per minute that miss the micro-cache, whatever their status. Same parsing as `RATE_LIMIT_MATCH_MAX`. |
| `RATE_LIMIT_LIST_READ_MAX` | `300` | Failed (status ≥ 400) reads of the candidate list and the question sets per IP per minute that reach the database; successful reads aren't counted. Same parsing as `RATE_LIMIT_MATCH_MAX`. |
| `RATE_LIMIT_MATCH_MAX` | `300` | Match requests per IP per minute. Positive safe integer only; invalid values warn at startup and fall back to 300. Unset or empty uses 300 without warning. Raise for load testing in prod mode; lower is more conservative against abuse. |

---

## Deployment steps

These steps apply on first deploy after the scaling work. Subsequent deploys
via CI/CD (rsync + `scripts/deploy.sh`, the same script as a manual deploy
below) are automatic.

### 1. Deploy the code

CI/CD handles this on push to `main`. If deploying manually:

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  ./ user@80.69.172.220:/opt/vaalikone/
# Builds and restarts; also restarts caddy if the Caddyfile changed, which
# `up -d` alone doesn't pick up.
ssh user@80.69.172.220 "sh /opt/vaalikone/scripts/deploy.sh"
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

### 3. Create the Cloudflare Cache Rule (and on Free, URL Rewrite Rules; one-time manual step)

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
   - **Cache key → Query string:** Ignore query string, **if the zone's plan
     offers it** (Cloudflare documents it for Enterprise and Pay-as-you-go,
     not Free). On the Free plan, leave the cache key alone and create the
     URL Rewrite Rules in sub-step 5 below instead.
4. Save and deploy the rule.
5. **Free plan only: drop the query string before the cache lookup.** These
   endpoints ignore the query string, and so does the micro-cache. With the
   default cache key, each new query string (`?x=<random>`) is a separate
   edge entry, so every such request misses and reaches the origin (#159).
   URL Rewrite Rules run before Cache Rules, so a rewrite that empties the
   query string makes them all one entry. Create two rules, one per path,
   under **Rules → Overview → Create rule → URL Rewrite Rule**:
   - **Rule name:** `Drop query string: candidates` /
     `Drop query string: question sets`
   - **If incoming requests match:** Wildcard pattern, **Request URL**
     `https://avoinvaalikone.fi/api/candidates*` /
     `https://avoinvaalikone.fi/api/question-sets*`
   - **Then rewrite the path and/or query:** Path: *Preserve*. Query:
     *Rewrite to*, **Target query** `*` (no leading `?`: the query field
     never contains it), **Rewrite to** left **empty** ("Leave this field
     empty to remove the query string", in Cloudflare's docs). The target
     must match the whole query; left empty, it would match only an empty
     query and change nothing.
   - Deploy both; sub-step 6 checks that each works.

   URL Rewrite Rules are Transform Rules, which every plan has (Free allows
   10 active ones; these use 2). Nothing under these paths reads the query
   string (the token routes and POSTs included), so the rewrite changes no
   response.
6. Check: `scripts/verify-edge-cache.sh` must pass (it runs after every
   deploy; see "4. Verify edge caching" for the manual checks). It probes
   both `/api/question-sets` and `/api/candidates` with a never-seen query
   string, so it checks the result whichever of sub-step 3 or 5 the zone
   uses, and each rewrite rule on its own.

**Optional: a Cloudflare rate-limiting rule on `/api/*`.** It counts per IP,
much like the origin limiters, so it doesn't add a bound; it moves a single-address
flood's cost (proxying through Caddy, nginx and Node to the 429) to the edge.
Security → WAF → Rate limiting rules, on
`starts_with(http.request.uri.path, "/api/")`. It counts every `/api/`
request (matches, token routes and reads alike), so size its threshold
against a carrier CGNAT address's whole legitimate `/api/` rate, which can be
hundreds of voters', not against the origin limits. A flood spread over many
addresses is bounded by neither; for that, rely on Cloudflare's DDoS and bot
protection. Each candidate-page request that gets past both caches costs the
database one or two primary-key lookups.

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

# A new query string is served from the same edge entry
curl -sI "https://avoinvaalikone.fi/api/question-sets?x=$(date +%s)$$" | grep cf-cache-status
# cf-cache-status: HIT  (UPDATING/EXPIRED/REVALIDATED/STALE if the entry just
# expired are fine too; MISS means the query string still reaches the cache key)

# The same for the candidate list (on the Free plan it has its own rewrite
# rule): request it twice, then with a new query string
curl -sI https://avoinvaalikone.fi/api/candidates | grep cf-cache-status; sleep 2
curl -sI https://avoinvaalikone.fi/api/candidates | grep cf-cache-status
# cf-cache-status: HIT  (DYNAMIC: the Cache Rule doesn't cover /api/candidates)
curl -sI "https://avoinvaalikone.fi/api/candidates?x=$(date +%s)$$" | grep cf-cache-status
# cf-cache-status: HIT  (MISS: the query string reaches the cache key; on the
# Free plan, check this path's rewrite rule)

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
curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://avoinvaalikone.fi/api/health | python3 -m json.tool
# {
#   "status": "ok",
#   "timestamp": "...",
#   "pool": { "total": 3, "idle": 3, "waiting": 0 }
# }
```

Without the token (or with a wrong one) there is no `pool` field; a wrong
token also counts toward the admin rate limit.

`waiting > 0` during the event means the pool is saturated — raise `PG_POOL_MAX`
or add a replica.

---

## Load testing

See [scripts/loadtest/README.md](../scripts/loadtest/README.md) for the HTTPS
preflight and full instructions. Caddy must have a valid certificate trusted
by the test host. Run these commands from `/opt/vaalikone` on the server.

Quick reference:

```bash
# On the server: keep the production hostname for TLS and Caddy routing;
# origin-local.json connects it to 127.0.0.1 and disables redirects.
# The voter flow also opens candidate pages, whose misses count against
# RATE_LIMIT_CANDIDATE_READ_MAX, all from this one host.
RATE_LIMIT_MATCH_MAX=100000 RATE_LIMIT_CANDIDATE_READ_MAX=100000 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend  # raise rate limits for test
NO_PROXY=avoinvaalikone.fi no_proxy=avoinvaalikone.fi k6 run \
  --config scripts/loadtest/origin-local.json \
  -e BASE_URL=https://avoinvaalikone.fi scripts/loadtest/voter-flow.js
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend  # afterwards: back to the .env value
```

Thresholds in the script:

- Error rate < 1 %
- `GET /api/question-sets` p95 < 300 ms
- `POST /api/voter/match` p95 < 800 ms
- `GET /api/candidates/:id` p95 < 300 ms

**Never load-test the public hostname without an origin connection override**
— that measures Cloudflare's cache and can trip its DDoS/bot mitigation against
your own IP. The config above keeps TLS verification enabled and measures
`Caddy → nginx → backend` on this server. It does not validate production
client-IP rate limiting: bypassing Cloudflare shortens the proxy chain while
`TRUST_PROXY_HOPS` still defaults to 3. Do not publish nginx or backend ports
for the test.

---

## Election-night checklist

- [ ] Cache Rule active in Cloudflare, and the edge ignoring the query string (the rule's cache key, or the URL Rewrite Rules on Free): `scripts/verify-edge-cache.sh` passes
- [ ] 3 backend replicas healthy (`docker compose ps`)
- [ ] Redis healthy (`docker compose exec redis redis-cli ping`)
- [ ] `RATE_LIMIT_MATCH_MAX` set appropriately (raise if CGNAT complaints), and `RATE_LIMIT_CANDIDATE_READ_MAX` with it (about 4×: voters open several candidates per match)
- [ ] Disk space adequate (`df -h /`) — log rotation limits logs to 3×10 MB per service
- [ ] Health endpoint polled manually: `pool.waiting` should stay 0
- [ ] Cloudflare analytics show cache hit ratio >90% for GET traffic
- [ ] Manual CF purge bookmarked for emergency staleness clears

## Emergency knobs

| Situation | Action |
|-----------|--------|
| Admin approves/hides a question set and it needs to be visible immediately | Cloudflare dashboard → Caching → Purge by URL → `https://avoinvaalikone.fi/api/question-sets` |
| Voters behind one carrier IP getting 429 | Raise `RATE_LIMIT_MATCH_MAX` in `.env` (and `RATE_LIMIT_CANDIDATE_READ_MAX` with it, about 4×: a 429 on opening a candidate fails silently in the UI), then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend`. Keep both `-f` files (without the prod overlay this recreates a single backend with `TRUST_PROXY_HOPS=1`, which puts every voter in one rate-limit bucket, and publishes port 3000 past Caddy and Cloudflare), and don't use `restart`, which keeps the old environment. All replicas are recreated at once, so expect a few seconds of 502s (the match request retries once) |
| Many 429s on public reads behind one IP | On candidate pages (`/api/candidates/<id>`): a client walking ids, or a crowd on a cold cache; for a crowd, raise `RATE_LIMIT_CANDIDATE_READ_MAX`. On the lists (`/api/candidates`, `/api/question-sets`), only failed reads count, so it's the database failing reads; check for 500s. Raise either the same way as `RATE_LIMIT_MATCH_MAX` above |
| DB pool exhaustion (`waiting > 0`) | Raise `PG_POOL_MAX` in `.env` (keep `replicas × PG_POOL_MAX` under 100), then `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend` |
| One backend replica unhealthy | Find the unhealthy container with `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps backend`, then run `docker restart <container>` for that container only. This leaves healthy replicas running; `docker compose restart backend` restarts them all. Restart is appropriate here because no environment values changed (unlike the rows above); migrations run on startup and nginx re-resolves DNS within 10 s |
