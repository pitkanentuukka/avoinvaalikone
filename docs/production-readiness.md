# Production Readiness

Changes on the `prod-readiness` branch that harden Vaalikone for an election-day
traffic spike behind the Cloudflare → Caddy → nginx → backend chain. Grouped by
concern; each item notes the relevant file(s) and the environment variables it
introduces.

## Summary

- **Horizontal scaling**: the backend runs as 3 replicas in production, fronted
  by nginx round-robin, with rate-limit state shared through Redis and DB
  connections bounded per process.
- **Caching**: public GET endpoints emit `Cache-Control` for Cloudflare edge
  caching, backed by a per-replica micro-cache and a covering index for the
  match query.
- **Resilience**: graceful shutdown, statement timeouts, fire-and-forget
  research writes, client-side retry on transient upstream errors, and nightly
  database backups.
- **Observability**: optional Sentry (backend + frontend), slow-query and
  pool-saturation logging, admin-only pool stats on the health endpoint, bounded
  container logs.
- **Security hardening**: unprivileged nginx, a Content-Security-Policy, referrer
  suppression, party-token scrubbing from the URL, and admin-gated health
  internals.

## Scaling & concurrency

### Multiple backend replicas
- `docker-compose.prod.yml` runs the `backend` service with `deploy.replicas: 3`
  (one Node process per vCPU; the match computation is CPU-bound JS). The
  `container_name` was removed from `docker-compose.yml` because fixed names are
  incompatible with replicas.
- nginx (`vaalikone-frontend/nginx.conf`) proxies `/api/` using a **variable**
  upstream plus Docker's embedded resolver (`resolver 127.0.0.11 valid=10s`).
  A literal hostname in `proxy_pass` is resolved once at startup and pins the
  IPs, so replica restarts would 502. The variable form forces re-resolution
  every 10s and round-robins across all live replicas.

### Bounded database connections
- `src/db/pool.js` reads pool size from `PG_POOL_MAX` (default 10). With N
  replicas the database sees up to N × `PG_POOL_MAX` connections; prod is
  3 × 10 = 30, kept well under Postgres `max_connections` (100).
- A `statement_timeout` (`PG_STATEMENT_TIMEOUT_MS`, default 10000) acts as a
  server-side kill switch so one runaway query can't pin pool slots across every
  replica. Migrations use their own `Client` and are exempt.

### Shared, safe migrations
- `migrations/run.js` takes a Postgres **advisory lock** (`pg_advisory_lock`) on
  a dedicated client before applying migrations. Every replica runs migrations on
  startup; the lock serializes them so late replicas block until the first
  finishes, then see everything already applied.
- `migrations/010_match_covering_index.sql` builds a covering index
  `CONCURRENTLY` (no write lock on `candidate_answers` during a campaign-period
  deploy). It therefore contains **no** `BEGIN/COMMIT` and does not touch
  `schema_migrations`; the runner records it in `migration_history` as usual. If
  a `CONCURRENTLY` build is interrupted it can leave an INVALID index — drop it
  and let the migration re-run (recovery command is in the file header).

## Caching

### Edge cache (Cloudflare)
- `src/middleware/cacheControl.js` provides `publicCache(sMaxage)` and
  `noStore`. Public GETs (`/api/question-sets`, `/api/candidates`,
  `/api/candidates/:id`) send
  `public, max-age=60, s-maxage=300, stale-while-revalidate=600`. A manual
  Cloudflare Cache Rule (see `docs/scaling.md`) makes these paths eligible with
  Edge TTL "respect origin headers".
- Tokened/admin routes (`/api/admin/*`, `/api/candidates/party/*`) send
  `no-store` so they can never be edge-cached even if a broad rule matches the
  path.
- `scripts/verify-edge-cache.sh [host]` checks that the edge rule is actually
  active (two requests; the second must be `cf-cache-status: HIT`). It runs in
  CI after deploy as a **warning** (never fails the deploy) and belongs in the
  election-night checklist, because the Cache Rule is manual dashboard state that
  disappears silently if the zone is recreated.

### Per-replica micro-cache
- `src/middleware/microCache.js` caches successful GET bodies in-process for 60s
  (keyed by `originalUrl`, capped at 500 entries). It is insurance for edge cache
  misses/purges and is **production-only** — in dev/test a 60s stale window would
  hide a writer's own changes. 60s per replica sits inside the 300s edge TTL, so
  there is no cross-replica invalidation.

### Match query index
- `010_match_covering_index.sql` adds
  `idx_candidate_answers_qid_cid_value ON candidate_answers (question_id,
  candidate_id) INCLUDE (value)`, enabling index-only scans for the match query,
  which now selects only `(candidate_id, question_id, value)`.

## Resilience

### Graceful shutdown
- `src/index.js` handles `SIGTERM`/`SIGINT`: stop accepting connections, drain
  in-flight requests, then release DB/Redis connections, with a 10s force-exit
  fallback. `server.closeIdleConnections()` drops nginx keep-alive sockets so
  `server.close()` can complete. The `Dockerfile` uses
  `node migrations/run.js && exec node src/index.js` so Node is PID 1 and
  actually receives the signal (`npm start` swallows it).

### Slimmer, faster match endpoint
- `src/routes/voter.js` no longer selects answer `explanation` text in the match
  query (it dominated response size). Explanations are lazy-loaded per candidate
  via `GET /api/candidates/:id` when a result card is expanded
  (`vaalikone-frontend/src/App.jsx`).
- The session id comes from the client (see below) or, failing that,
  `crypto.randomUUID()`, instead of a `SELECT gen_random_uuid()` round-trip.
- The `voter_responses` research insert is **fire-and-forget** (not awaited) so
  it adds no latency to the match response; losing anonymized rows on a crash is
  acceptable. Errors are caught and logged.

### Client-side retry
- `apiFetch` in `vaalikone-frontend/src/api.js` retries once after a 1s delay
  on `502/503/504` or a network error, smoothing over a replica restarting
  during a rolling deploy. Only `GET`s and requests marked `retry: true` are
  retried; any other request may already have taken effect when its response
  was lost.
- The match POST is marked retryable: the client generates its `sessionId` and
  resends the same one, so the retry's research insert hits
  `ON CONFLICT DO NOTHING` instead of storing a second session.

## Rate limiting

- `src/redis.js` creates an optional Redis client when `REDIS_URL` is set;
  `src/middleware/rateLimitStore.js` wires a `rate-limit-redis` store so limits
  hold **across replicas** instead of multiplying by the replica count. Without
  `REDIS_URL` (local dev) limiters fall back to per-process memory.
- All limiters set `passOnStoreError: true` — they **fail open** if Redis is
  unreachable. Losing shared rate limiting during a Redis outage is far better
  than dropping the voter-match endpoint on election night.
- The voter-match limit is now `RATE_LIMIT_MATCH_MAX` (default **300**/min, up
  from 60). The higher default tolerates carrier CGNAT (many voters behind one
  IP) while still capping a single abuser at ~5 req/s, and is the dial for k6
  load tests against a production-mode deployment.
- The `redis` service in `docker-compose.yml` is internal-only, non-persistent
  (`--save ""`), 64 MB, with `noeviction` (silently evicting rate-limit keys
  under memory pressure would disable limiting).

## Observability

- **Sentry** (`src/instrument.js`, required first in `src/index.js`;
  `vaalikone-frontend/src/main.jsx`) — inert unless `SENTRY_DSN` /
  `VITE_SENTRY_DSN` is set. Errors only (`tracesSampleRate: 0`) to stay within
  free-tier quota. The backend registers `Sentry.setupExpressErrorHandler`
  before the JSON error handler.
- **Slow-query & pool logging** (`src/db/pool.js`) — logs any query over 500 ms
  and warns every 30s when the pool has waiting requests (the early signal to
  raise `PG_POOL_MAX` or replica count).
- **Health endpoint** (`GET /api/health`) — no DB round-trip (probed
  frequently); returns pool counters (`total`/`idle`/`waiting`) **only** to an
  authenticated admin, so operators can curl it during the event without leaking
  saturation to the public.
- **Production request logging** — morgan skips 2xx/3xx in production (logs only
  failures) to avoid event-loop and disk overhead at election-day rates.
- **Bounded container logs** — every compose service uses a `json-file` driver
  capped at 10 MB × 3 files so logs can't fill the disk.
- **Postgres tuning** — the `db` service sets `shared_buffers=256MB`,
  `effective_cache_size=768MB`, and `log_min_duration_statement=250`.

## Security hardening

- **Unprivileged frontend** — `vaalikone-frontend/Dockerfile` uses
  `nginxinc/nginx-unprivileged` (uid 101) listening on **8080**. The `Caddyfile`
  and compose port mapping (`80:8080`) point at 8080 accordingly.
- **Unprivileged backend** — the `Dockerfile` runs as the `node` user.
- **Content-Security-Policy** (`nginx.conf`) — `script-src 'self'` (no inline
  scripts), `style-src 'self' 'unsafe-inline'` (the app styles inline),
  `img-src 'self' https: data:` (candidate `photo_url` is an arbitrary
  user-supplied URL), `connect-src 'self' https://*.sentry.io`.
- **Referrer-Policy: no-referrer** — party, registration and candidate tokens
  arrive as `?partyToken=` / `?register=` / `?candidateToken=` magic links and
  must never leak via `Referer`.
- **Token scrubbing** (`App.jsx`) — the token is read once, then removed
  from the address bar via `history.replaceState` so it doesn't linger in
  history, bookmarks, or copied URLs.
- **Admin auth refactor** (`src/middleware/auth.js`) — `isAdminRequest(req)`
  extracts the timing-safe Bearer check (used by both `requireAdmin` and the
  health endpoint) and guards against an unset `ADMIN_SECRET`.
- **gzip through proxies** (`nginx.conf`) — `gzip_proxied any` so responses are
  compressed even when they carry a `Via` header from Caddy/Cloudflare.

## Backups

- `scripts/backup/` is a sidecar (`postgres:16-alpine` + `rclone`, driven by
  busybox `crond`) that runs nightly at 03:00 UTC. It `pg_dump`s custom/compressed
  format to the `backup_data` volume, uploads to S3-compatible UpCloud Object
  Storage, prunes remote dumps older than 30 days, and keeps only the newest
  local dump as a restore cache.
- Enabled in `docker-compose.prod.yml`. If the `BACKUP_S3_*` vars are unset the
  sidecar still runs and keeps a local dump, logging a warning instead of
  uploading. Restore steps: `scripts/backup/restore.md`.

## New environment variables

All optional; defaults keep local dev working unchanged. See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PG_POOL_MAX` | 10 | Connections per backend process |
| `PG_STATEMENT_TIMEOUT_MS` | 10000 | Server-side query kill switch (app pool only) |
| `REDIS_URL` | unset | Shared rate-limit store; unset → per-process fallback |
| `RATE_LIMIT_MATCH_MAX` | 300 | Voter-match requests per IP per minute |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | unset | Error tracking (inert when unset) |
| `BACKUP_BUCKET` | unset | S3 bucket for nightly dumps; unset → local-only |
| `BACKUP_S3_ENDPOINT` / `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | unset | UpCloud Object Storage credentials |

## New dependencies

- Backend: `@sentry/node`, `redis`, `rate-limit-redis`.
- Frontend: `@sentry/react`.

## Related docs

- `docs/runbook.md` — operational runbook.
- `docs/scaling.md` — the manual Cloudflare Cache Rule and edge-cache setup.
- `docs/scaling-10x.md` — headroom analysis for a 10× spike.
