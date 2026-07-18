# Scaling 10× plan (~5,000 req/s peak) — for later implementation

Status: **planned, not implemented.** This builds on the ~500 req/s work
documented in [scaling.md](scaling.md). Do not start here — everything in
that document is a prerequisite.

---

## 1. What changes at 10×

At 500 req/s the problem was "stop hitting Postgres for every page load."
Cloudflare now absorbs the GETs, so at 5,000 req/s the only traffic class that
grows at the origin is the uncacheable `POST /api/voter/match` —
budget **~1,500–2,500 match/s**. Three things break before CPU does:

1. **Origin egress.** The match response still carries each candidate's full
   per-question `answers` map plus `bio` (`src/routes/voter.js:119,161-165`).
   Rough math with 200 candidates × 50 questions: ~860 KB raw, ~80 KB gzipped
   per response. At 2,000 match/s that is **~160 MB/s ≈ 1.3 Gbps** — more than
   a typical UpCloud uplink. Payload reduction is **mandatory**, not an
   optimization (§3.1).
2. **Per-match DB reads.** Two reads per match × 2,000/s = 4,000 queries/s of
   the *same small dataset* (candidate_answers is ~1 MB total). The dataset
   must live in process memory (§3.2).
3. **Research insert volume.** 2,000 sessions/s × ~30 answers = up to
   **60k rows/s** into `voter_responses`. Per-request INSERTs (even
   fire-and-forget) consume pool slots and WAL; inserts must be batched (§3.3).

And one thing that breaks *operationally*: a single server is a single point
of failure on the one night the site must not go down. 10× capacity should be
bought as **redundancy first, headroom second** (§4).

### Capacity model (assumptions stated)

| Quantity | Assumption | Implication |
|---|---|---|
| Peak total traffic | 5,000 req/s | CF edge absorbs GETs (with Tiered Cache, hit ratio >99%) |
| Peak match POSTs | 2,000/s | The entire origin design target |
| Candidates × questions | ≤300 × ≤60 = ≤18k answer rows (~1–2 MB) | Trivially fits in process memory |
| CPU per match (after §3) | ~0.5–1 ms (scoring 10–20k ops + ~30 KB JSON serialize) | One Node process ≈ 300–500 match/s with headroom → **6–8 processes total** |
| Match response (after §3.1) | ~40 KB raw / ~8 KB gzipped | 2,000/s × 8 KB ≈ 16 MB/s ≈ 130 Mbps — comfortable |
| DB write load (after §3.3) | batched COPY/multi-row, ~60k rows/s peak | Needs a dedicated DB host and partitioned table |

Conclusion: **2 app servers (8 vCPU each, 6–8 backend replicas total) + 1 DB
server**, behind Cloudflare Load Balancing. A single 16 vCPU box could carry
the load but fails the redundancy requirement.

---

## 2. Phasing overview

| Phase | Theme | Infra cost | Can ship independently |
|---|---|---|---|
| A | Code: make match DB-free and small | none | yes — do this first, it helps at any scale |
| B | Edge: squeeze more out of Cloudflare | none/≈€0 | yes |
| C | Infra: split DB out, 2 app servers, LB | ~2–3× current hosting | needs A for connection math to work |
| D | Operations: metrics, 10× load test, game day | minor | last |

Phases A and B alone roughly triple the single-server ceiling. C buys the
rest plus redundancy.

---

## 3. Phase A — code changes (no new infra)

### 3.1 Shrink the match response to metadata + score

**Problem:** the per-candidate `answers` map dominates payload (§1.1), and the
UI needs it only inside an expanded card — where it *already* lazy-loads the
full candidate (values + explanations) from the edge-cached
`GET /api/candidates/:id`.

**Change:**
- `src/routes/voter.js` — drop `answers` and `bio` from each result item.
  Keep `id, name, photoUrl, constituency, partyId, partyName, match,
  answeredCount`. (~150 B/candidate → ~40 KB raw for 300 candidates.)
- `vaalikone-frontend/src/App.jsx` results view — the expanded card currently
  reads `c.answers[q.id].value` for the you-vs-candidate comparison; switch it
  to `candidateDetails[c.id].answers[q.id].value` (the lazy-loaded record,
  which the explanation rendering already uses). Show a small loading state on
  first expand. `bio` likewise comes from `candidateDetails` (the
  `CandidateProfile` modal already fetches the full record).
- Optional: cap results at the top ~100 with a "show all" that re-renders
  locally — only worth it if candidate count grows beyond ~500.

**Effect:** origin egress per match drops ~10×; JSON serialization CPU drops
with it. The values move to a response Cloudflare caches once per candidate.

### 3.2 In-memory match dataset (per replica, refreshed)

**Problem:** 2 reads/match × 2,000/s of an effectively static ~1 MB dataset.

**Change:** new module `src/matchDataset.js`:
- Loads, in one place: all `candidate_answers (candidate_id, question_id,
  value)`, candidate metadata + party names, the `question_set_questions`
  membership map (for `questionSetIds` filtering), and the set of valid
  question IDs (replaces the per-request `SELECT id FROM questions` stale-ID
  filter).
- Exposes synchronous lookups the route uses instead of SQL. Candidate
  constituency filtering happens on the in-memory candidate list.
- Refreshes via `setInterval` every 60 s (jittered per replica), keeping the
  previous snapshot on refresh failure. 60 s staleness matches the edge-cache
  staleness already accepted.
- On process start, block readiness (`/api/health` returns 503) until the
  first load succeeds — keeps a replica out of rotation until it can serve.

**Effect:** the match endpoint performs **zero reads** per request. DB read
load becomes `replicas × 1 query/min`. This also unlocks graceful degradation
(§5): match keeps working from the snapshot when the DB is down.

**Caution:** the existing unit tests mock `db.query` per-call; they will need
to seed the dataset module instead (give it a `_setSnapshot()` test hook).

### 3.3 Batch the research inserts

**Problem:** one INSERT per match holds a pool slot; 2,000/s competes with
everything else and bloats WAL.

**Change:** new `src/voterResponseBuffer.js`:
- `push(sessionId, rows)` appends to an in-memory array; a 1 s interval (or
  5,000-row high-water mark, whichever first) flushes the buffer with a single
  multi-row INSERT (or `pg-copy-streams` COPY if profiling demands it).
- Flush inside `SET LOCAL synchronous_commit TO off` — on a DB crash we lose
  at most ~0.5 s of research rows instead of risking anything stronger.
  (Do **not** use an UNLOGGED table: crash recovery truncates the whole table.)
- Cap the buffer (e.g. 100k rows); when full, drop new rows and increment a
  counter exposed on `/api/health`. Research data is explicitly sacrificial
  under overload.
- Migration: range-partition `voter_responses` by day (`answered_at`), so
  election-day volume (potentially >100 M rows) can be detached/archived
  without VACUUM pain.

**Effect:** insert overhead amortizes ~1000×; pool usage on the match path
drops to ~zero. Per-replica `PG_POOL_MAX` can drop to ~5, which is what makes
the multi-server connection math work (§4.3).

---

## 4. Phase B — edge improvements (config only)

1. **Tiered Cache** (Cloudflare dashboard → Caching → Tiered Cache, free):
   colos fetch from an upper-tier colo instead of each missing to origin
   independently. Materially raises hit ratio for the question-sets JSON.
2. **Election-day TTL raise:** question sets are frozen once voting starts.
   Bump `publicCache(300)` → `publicCache(3600)` for `/api/question-sets`
   behind an env var (e.g. `CACHE_SMAXAGE_QUESTION_SETS`), flip it on election
   week. One origin fetch per upper-tier per hour.
3. **Edge rate limit on `/api/voter/match`:** one Cloudflare rate-limiting
   rule (free tier includes one): e.g. 100 req / 1 min per IP → managed
   challenge or block. Abusive traffic burns Cloudflare's capacity, not ours;
   the origin's Redis limiter (300/min) stays as the precise second line.
4. **Break-glass bot control:** pre-create (disabled) a Turnstile/managed
   challenge rule for `/api/voter/match` to flip on if a bot wave hits during
   the event. Test it once beforehand so the frontend handles a challenge
   gracefully.

---

## 5. Phase C — infrastructure split

Target shape:

```
Cloudflare (cache + LB, health-checked origin pool)
   ├── app1: Caddy → nginx → backend ×3..4, Redis (primary)
   ├── app2: Caddy → nginx → backend ×3..4  ──┐ REDIS_URL → app1 (private net)
   └── db1:  PostgreSQL 16 (dedicated)  ◄─────┴── DATABASE_URL (private net)
```

### 5.1 Servers

- **2 × app server** (UpCloud, 8 vCPU / 16 GB): each runs the existing compose
  stack minus the `db` service; backend `deploy.replicas: 4` per box.
- **1 × DB server** (8 vCPU / 32 GB or UpCloud Managed PostgreSQL): move data
  with `pg_dump | pg_restore` during a maintenance window (the dataset is
  small; minutes of downtime, or do logical replication for zero-downtime).
  Tune: `shared_buffers` 8 GB, `max_connections` 200, same
  `log_min_duration_statement`.
- All three on a **private/utility network** (UpCloud SDN); Postgres and Redis
  listen only there. Public interfaces expose only Caddy's 80/443.

### 5.2 Load balancing

- **Cloudflare Load Balancing** (paid add-on, ~$5–10/mo): origin pool with
  app1+app2, health monitor on `/api/health` (which §3.2 made
  readiness-accurate), steering = least outstanding requests or round-robin.
  No session affinity needed — the app is stateless; rate limits live in the
  shared Redis.
- Budget alternative: DNS round-robin on two A records — rejected: no health
  checking, failover is at DNS-TTL mercy.

### 5.3 Shared state

- **Redis** stays a single instance on app1, reachable over the private
  network (`REDIS_URL=redis://10.x.x.x:6379`, protected-mode with a password
  via `requirepass`). If app1 dies, app2's limiter falls back to its in-memory
  store automatically (`src/middleware/rateLimitStore.js` already handles
  absent Redis) — degraded but functional. A Redis HA pair is overkill here.
- **Connection math:** 8 replicas × `PG_POOL_MAX=5` (post-§3.3) = 40
  connections; even ×2 headroom stays far under 200. **pgbouncer is not
  needed** if Phase A lands first — revisit only if pools are raised.

### 5.4 Deploy pipeline

Building images on every server (`docker compose up --build`) doesn't scale to
N servers and risks version skew mid-event:

- CI builds backend + frontend images once, pushes to **GHCR** tagged with the
  commit SHA.
- Compose files reference `image: ghcr.io/...:${TAG}`; deploy job runs
  `docker compose pull && docker compose up -d` over SSH on each app server,
  sequentially, with the health check gating between servers (rolling deploy,
  zero downtime behind the LB).
- `.github/workflows/ci-cd.yml`: replace the rsync+build step; keep rsync for
  compose/config files only.

### 5.5 Graceful degradation (cheap insurance, big payoff)

With §3.2 + §3.3 in place, wire the failure paths explicitly:

- **DB unreachable:** match serves from the last dataset snapshot; the insert
  buffer accumulates to its cap, then drops. Voters never notice. `/api/health`
  reports `db: "degraded"` (LB keeps the origin in rotation — degraded is
  better than down).
- **Redis unreachable:** limiters fall back per-process (already implemented).
- **Both app servers down:** Cloudflare "Always Online" / a static maintenance
  page rule — configure once, hope to never use.

---

## 6. Phase D — observability and validation

Current observability (health counters + log greps) is fine for one box, blind
for three.

1. **Metrics:** add `prom-client` to the backend — default Node metrics plus
   counters/histograms for match latency, dataset snapshot age, insert-buffer
   depth/drops, rate-limit rejections. Expose `/metrics` on the private
   network only. One small VM (or Grafana Cloud free tier) runs
   Prometheus + Grafana + node_exporter/postgres_exporter on all three hosts.
   Alert rules: p95 match latency, snapshot age > 5 min, buffer drops > 0,
   `pool.waiting > 0`, disk > 80 %.
2. **10× load test:** extend `scripts/loadtest/voter-flow.js` ramp to
   1,250 iter/s (~5,000 req/s). k6 needs ~4–8 vCPUs itself — run it from a
   separate temporary UpCloud VM **on the private network against each app
   server and against the LB origin pool**, never through the public
   Cloudflare edge. New thresholds: match p95 < 800 ms at 2,000 match/s,
   error rate < 0.5 %, zero insert-buffer drops below 1,500 match/s.
3. **Game day (1–2 weeks before the election):** kill a backend replica, an
   app server, Redis, and the DB (in that order) under ~50 % synthetic load;
   verify the degradation paths in §5.5 and that alerts fire. Time-box fixes.

---

## 7. Implementation order & effort

| # | Item | Touches | Effort | Depends on |
|---|------|---------|--------|------------|
| 1 | §3.1 slim match response + client-side comparison | `voter.js`, `App.jsx`, tests | 0.5–1 d | — |
| 2 | §3.2 in-memory match dataset | new `matchDataset.js`, `voter.js`, health, tests | 1–2 d | — |
| 3 | §3.3 insert buffer + partitioned `voter_responses` | new buffer module, migration | 1 d | — |
| 4 | §4 edge config (tiered cache, TTL env, edge rate limit) | CF dashboard, `cacheControl.js` | 0.5 d | — |
| 5 | §5.4 GHCR image pipeline | CI, compose | 0.5–1 d | — |
| 6 | §5.1–5.3 servers, private net, LB, DB move | infra + compose split | 1–2 d + window | 1–3, 5 |
| 7 | §6.1 metrics stack | backend + 1 VM | 1 d | 6 |
| 8 | §6.2–6.3 10× load test + game day | loadtest VM | 1 d + game day | all |

Rough total: **6–9 working days** plus the DB migration window and a game day.

## 8. Risks / open questions

- **Frontend comparison change (§3.1)** is the only user-visible change:
  expanded cards gain a brief loading state. Validate UX on slow mobile.
- **Dataset snapshot staleness (§3.2):** a candidate's edited answer takes up
  to 60 s + edge TTL to affect new matches — same class of staleness already
  accepted; document it for admins.
- **voter_responses retention:** at 10× the research table needs an explicit
  retention/archival decision (detach partitions to cold storage?) — owner
  needed.
- **Cost ceiling:** 2 app + 1 DB UpCloud servers + LB ≈ 3× current hosting
  spend; confirm budget before Phase C. Phases A+B are free and worth doing
  regardless of whether C ever happens.
- **Cloudflare plan limits:** LB and >1 rate-limit rule may require paid
  add-ons; confirm against the zone's current plan.
