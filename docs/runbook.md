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
stuck and CI is unavailable, rsync an earlier checkout to the box with the
rsync command in docs/scaling.md, "Deploy the code" (its `--rsync-path` waits for
a deploy still running there), and once that has succeeded run
`sh /opt/vaalikone/scripts/deploy-detached.sh` there: it runs `scripts/deploy.sh`
detached, so a dropped connection doesn't cut the deploy short, and logs it in
`/var/log/vaalikone-deploy/` (as root; another user's go to
`~/.local/state/vaalikone-deploy/`). Not a bare `compose up`: it doesn't pick up
a changed Caddyfile. A checkout from before
`deploy-detached.sh` was added (#205) doesn't have it, and its `deploy.sh` doesn't
take the lock itself: run
`setsid -w nohup sh -c 'flock -w 600 /opt/vaalikone sh /opt/vaalikone/scripts/deploy.sh; echo "Deploy ended with exit status $?"' > ~/deploy.log 2>&1 </dev/null &`
there instead (then `tail -f ~/deploy.log`; only that last line, with exit status
1, means the lock wait ran out). Not with a newer `deploy.sh`: it
would wait for that lock in vain.

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
| Deploy job timed out, or ssh says `Timeout, server 80.69.172.220 not responding.` | CI lost the server (#178), during the rsync or the deploy. A deploy that had started carries on there, detached (#205) | The job's log names the deploy's log (`Deploy log on the server: …`); if it doesn't, look in `/var/log/vaalikone-deploy/` for one from this run's time (the names are in UTC). None from then: the deploy never started, and the tree may be half-synced, so re-run as below. The log ends with the deploy's outcome (`Deploy ended … with exit status N`) once it has finished. Without that line it is still running if `pgrep -as <id>` lists any of its processes (`deploy.sh`, `docker`; after a reboot the id can belong to something else). The id is in the log's first line: `to stop it: pkill -s <id>`. No such processes means it was killed (or the server rebooted) partway. If it never started, failed or was killed, or the site looks wrong, re-run the **latest** deploy job or push again (re-running an older one deploys its older tree); it waits for a deploy that is still running |
| Deploy fails with `Waiting for another deploy to finish` followed by rsync's `connection unexpectedly closed`, or with `Gave up: another deploy is still running` | A deploy, or several deploys or rsyncs in a row, has held the tree's lock for 10 minutes (#205) | `flock -n /opt/vaalikone true && echo free` tells whether the lock is still held. The holder's log, in `/var/log/vaalikone-deploy/` (or a non-root deployer's `~/.local/state/vaalikone-deploy/`), says `Got the deploy lock`; a deploy waiting behind it doesn't. `pgrep -as <id>`, with the id from the log's first line, lists the holder's processes (`deploy.sh`, `docker`); if it lists neither, that deploy has ended, and after a reboot the id can belong to something else, so don't kill it. Ctrl-C in the ssh session only stops following the log; if the deploy is stuck, stop all of it with the command in the log's first line (`to stop it: pkill -s <id>`), which can leave some services recreated and some not. If `pgrep -as <id>` still lists something, such as a hung `docker compose`, it keeps the lock: `pkill -KILL -s <id>`. No such log: someone ran `deploy.sh` or rsync directly (as root, `fuser -v /opt/vaalikone` lists the processes, holder and waiters alike). Then deploy again |
| Deploy's "Set up SSH" fails with `The SSH_KNOWN_HOSTS repository variable has no host key for 80.69.172.220`, or its rsync or ssh says `Host key verification failed.` (after `REMOTE HOST IDENTIFICATION HAS CHANGED!` if the key differs) | CI accepts only the server host key pinned in the `SSH_KNOWN_HOSTS` repository variable (#206). Either the variable is unset or wrong, the server's host keys changed (a reinstall, regenerated keys), or something else is answering at the address | Don't pin whatever `ssh-keyscan` returns now: that would trust the very key in question. Compare it with the key read on the box itself, through UpCloud's web console rather than over the network: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there, and `ssh-keyscan -t ed25519 80.69.172.220 \| ssh-keygen -lf -` from anywhere. If the fingerprints match, set the variable to that one line (`gh variable set SSH_KNOWN_HOSTS --body "$(ssh-keyscan -t ed25519 80.69.172.220 2>/dev/null)"`, or Settings → Secrets and variables → Actions → Variables) and re-run the latest deploy job. If they don't match, don't deploy: something is impersonating the server |
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
