# Ops runbook

Production: single UpCloud box, `Cloudflare → Caddy → frontend nginx → backend ×3`
(compose files `docker-compose.yml` + `docker-compose.prod.yml` in `/opt/vaalikone`).
Deploys happen automatically on push to `main` (`.github/workflows/ci-cd.yml`).

## Rollback

Deploys are rebuild-from-source; there is no image registry to pin. To roll back:

```bash
git revert <bad commit(s)>   # or: git revert -m 1 <merge commit>
git push origin main         # CI redeploys the reverted tree
```

Migrations are **forward-only** (`migration_history` table): never delete or edit
an applied migration — write a new compensating migration instead. If a deploy is
stuck and CI is unavailable, SSH to the box and run the compose up command from
the workflow's "Build & restart services" step with an earlier checkout.

## Incident quick reference

| Symptom | Meaning | Action |
|---|---|---|
| `DB pool saturated: … waiting=N` in backend logs | Queries queueing for connections | Check for slow queries (db logs, `log_min_duration_statement=250`); dials: `PG_POOL_MAX`, backend `replicas`, `RATE_LIMIT_MATCH_MAX` |
| `Redis error:` / `Redis connect failed:` | Shared rate-limit store down | No action needed short-term: limiters fall back to per-process (effective limits ×3). Restart redis when convenient |
| Lots of 429s on `/api/voter/match` | Rate limit too tight for CGNAT crowds | Raise `RATE_LIMIT_MATCH_MAX` in `/opt/vaalikone/.env`, `docker compose … up -d backend` |
| Slow `/api/*` GETs + high DB load | Edge cache not serving | `scripts/verify-edge-cache.sh` — if DYNAMIC, recreate the Cloudflare Cache Rule (docs/scaling.md) |
| `statement timeout` errors | A query hit `PG_STATEMENT_TIMEOUT_MS` (10 s) | Find and fix the query; the timeout is protective, don't just raise it |
| Backend restart loops | Migration failure (runs on every start) | `docker compose logs backend`, fix the migration, redeploy |

Health/load at a glance: `curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://avoinvaalikone.fi/api/health`
— pool counters (`waiting > 0` = saturation; only returned for the admin
token, and a wrong token counts toward the admin rate limit). Errors: Sentry (backend + frontend).

## Election-night checklist

- [ ] `scripts/verify-edge-cache.sh` passes (CF-Cache-Status: HIT)
- [ ] Latest nightly dump exists in the backup bucket (`postgres/vaalikone-<yesterday>.dump`); take a fresh manual one: `docker compose … exec backup backup.sh`
- [ ] Sentry receiving events (send a test event, check the project dashboard)
- [ ] `RATE_LIMIT_MATCH_MAX` set for the night (default 300/min/IP)
- [ ] `docker compose … ps` — all services healthy, 3 backend replicas
- [ ] Watch: `/api/health` pool counters, Cloudflare analytics cache-hit ratio, Sentry

## Restore from backup

See [scripts/backup/restore.md](../scripts/backup/restore.md).

## Known accepted limitations

- **Single Postgres, no failover** — accepted SPOF at ~500 req/s scale; redundancy is
  planned as part of the 10× work (docs/scaling-10x.md §4).
- **No container resource limits** — single-tenant box; an OOM-killed database
  mid-election would be worse than host-level memory pressure.
- **No log aggregation / admin audit trail / 2FA** — real gaps, deliberately deferred;
  logs rotate locally (10 MB × 3 per service), so capture anything important promptly.
