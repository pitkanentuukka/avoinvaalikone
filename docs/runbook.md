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
stuck and CI is unavailable, rsync an earlier checkout to the box as the
workflow's "Rsync to server" step does (its `--rsync-path` waits for a deploy
still running there), and run `sh /opt/vaalikone/scripts/deploy-detached.sh`
there: it runs `scripts/deploy.sh` detached, so a dropped connection doesn't cut
the deploy short, and logs it in `/var/log/vaalikone-deploy/` (as root; another
user's go to `~/.local/state/vaalikone-deploy/`). Not a bare
`compose up`: it doesn't pick up a changed Caddyfile. A checkout from before
`deploy-detached.sh` was added (#205) doesn't have it, and its `deploy.sh` takes
no lock: check that nothing is still deploying (`pgrep -af 'deploy.sh|docker compose'`),
and run `setsid -w nohup sh /opt/vaalikone/scripts/deploy.sh > ~/deploy.log 2>&1 </dev/null &`
there instead (then `tail -f ~/deploy.log`).

## Incident quick reference

| Symptom | Meaning | Action |
|---|---|---|
| `DB pool saturated: … waiting=N` in backend logs | Queries queueing for connections | Check for slow queries (db logs, `log_min_duration_statement=250`; bind parameters are left out, and errors are logged terse, without DETAIL/HINT/CONTEXT (so a deadlock shows no process or query detail), as they'd log tokens, #36); dials: `PG_POOL_MAX`, backend `replicas`, `RATE_LIMIT_MATCH_MAX` |
| `Redis connection failing:` / `Rate-limit store failing:` (then a `still failing: N more failures…` summary at most once a minute, and `recovered` within a minute of it being back; a new outage within a minute of the last line shows as `failing again:` or, if already over, `failed again and recovered:`) | Shared rate-limit store down | Limiters fail open: requests go through **unlimited** (no per-process fallback) until Redis is back, then limiting resumes by itself. Restart redis soon |
| Lots of 429s on `/api/candidates*` or `/api/question-sets` | Public-read limits (count only reads past the micro-cache) | Candidate pages count every miss: a client walking ids, or a CGNAT crowd on a cold cache (raise `RATE_LIMIT_CANDIDATE_READ_MAX`). The lists count only failed reads: the database failing them (check for 500s; `RATE_LIMIT_LIST_READ_MAX`). Raise the same way as `RATE_LIMIT_MATCH_MAX` below |
| Lots of 429s on `/api/voter/match` | Rate limit too tight for CGNAT crowds | Raise `RATE_LIMIT_MATCH_MAX` in `/opt/vaalikone/.env`, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend` (keep both files to preserve 3 replicas, proxy trust and unpublished backend ports; `restart` keeps the old environment) |
| Slow `/api/*` GETs + high DB load | Edge cache not serving | `scripts/verify-edge-cache.sh` — if DYNAMIC, recreate the Cloudflare Cache Rule (and on the Free plan the URL Rewrite Rules); if only a query-string probe misses, set the rule's cache key to ignore the query string, or on Free add or fix that path's URL Rewrite Rule (docs/scaling.md, "3. Create the Cloudflare Cache Rule") |
| `statement timeout` errors | A query hit `PG_STATEMENT_TIMEOUT_MS` (10 s) | Find and fix the query; the timeout is protective, don't just raise it |
| `SMTP-tarkistus epäonnistui` in backend logs or Sentry, or `failed` rows in `email_log` | Email isn't going out (candidate links, notifications) | Check `SMTP_*` in `/opt/vaalikone/.env` and the provider's status; after fixing, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend`. Re-send missed candidate links from the admin's per-party "send candidate links" |
| Deploy fails with `required variable SMTP_HOST` (or `SMTP_FROM`) `is missing a value` | `.env` has no SMTP settings | Add them (docs/production-readiness.md, Email) and deploy again. The old containers keep running meanwhile, but every `docker compose -f docker-compose.yml -f docker-compose.prod.yml …` command (`logs`, `ps`, `exec`) fails the same way until `.env` has them |
| Deploy job timed out, or ssh says `Timeout, server not responding` | CI lost the server mid-deploy (#178). The deploy itself carries on there, detached (#205) | Read the newest log in `/var/log/vaalikone-deploy/` on the server: it ends with the deploy's outcome (`Deploy ended … with exit status N`) once it has finished. Without that line it is still running if `pgrep -as <id>` lists its `deploy.sh` (the id is in the log's first line: `to stop it: pkill -s <id>`); otherwise it was killed (or the server rebooted) partway. If it failed, or the site looks wrong, re-run the **latest** deploy job or push again (re-running an older one deploys its older tree); it waits for a deploy that is still running |
| Deploy fails with `Waiting for another deploy to finish` followed by rsync's `connection unexpectedly closed`, or with `Gave up: another deploy is still running` | A deploy has held the tree's lock for 10 minutes (#205) | `flock -n /opt/vaalikone true && echo free` tells whether the lock is still held. The holder's log in `/var/log/vaalikone-deploy/` says `Got the deploy lock` (a deploy waiting behind it doesn't) and has no `Deploy ended` line yet. `pgrep -as <id>`, with the id from that log's first line, must list its `deploy.sh`: if it doesn't, that deploy was killed and isn't the holder. Ctrl-C in the ssh session only stops following the log; if the deploy is stuck, stop all of it with the command in the log's first line (`to stop it: pkill -s <id>`), which can leave some services recreated and some not. No such log: someone ran `deploy.sh` or rsync directly (`fuser -v /opt/vaalikone` lists the processes, holder and waiters alike). Then deploy again |
| Backend restart loops | Migration failure (runs on every start) | `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backend`, fix the migration, redeploy |
| 502/504 from the site | A proxy can't reach the next hop | Caddy and nginx don't log upstream errors (they'd log tokens, #36). `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` for a down container; `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs frontend`: `upstream=-` = the backend name didn't resolve (no replica running), `upstream_status=502` with `uct=-` = no connection (a backend refused or is gone), 504 / a high `urt` = hung. No line there = Caddy couldn't reach the frontend |

Health/load at a glance: `curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://avoinvaalikone.fi/api/health`
— pool counters (`waiting > 0` = saturation; only returned for the admin
token, and a wrong token counts toward the admin rate limit). Errors: Sentry (backend + frontend).

## Election-night checklist

- [ ] `scripts/verify-edge-cache.sh` passes (CF-Cache-Status: HIT, also with a new query string)
- [ ] Latest nightly dump exists in the backup bucket (`postgres/vaalikone-<yesterday>.dump`); take a fresh manual one: `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh`
- [ ] Restore drill done in the weeks before the election (date: ____), not tonight ([scripts/backup/restore.md](../scripts/backup/restore.md#restore-drill))
- [ ] Email goes out: backend logs show `SMTP-yhteys toimii`, and a re-sent candidate link arrives (not in spam)
- [ ] Sentry receiving events (send a test event, check the project dashboard)
- [ ] `RATE_LIMIT_MATCH_MAX` set for the night (default 300/min/IP), and `RATE_LIMIT_CANDIDATE_READ_MAX` with it (default 1200, about 4×)
- [ ] `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` — all services healthy, 3 backend replicas
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
