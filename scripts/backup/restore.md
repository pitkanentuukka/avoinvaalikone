# Restoring a Postgres backup

Dumps are `pg_dump -Fc` custom-format archives named `vaalikone-<UTC stamp>.dump`.
The newest one is always in the `backup_data` volume (`/backups` inside the
backup container); older ones live in the object-storage bucket under `postgres/`.

Keep the restore clear of 03:00 UTC: a nightly backup that starts during it may
wait for it and then save a dump with empty tables, which replaces the local dump
and is uploaded. After the restore, check the 03:00 backup log
(`docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backup`), or
run backup.sh by hand (`docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh`).

```bash
# BACKUP_BUCKET and DATABASE_URL are set only inside the backup container, so
# the commands that use them run under sh -c '…': the single quotes stop the
# host shell from expanding them (to nothing) first.

# 1. Fetch a dump from the bucket if the local one isn't the version you need.
#    Into /backups/restore/, not /backups/: backup.sh deletes every
#    /backups/vaalikone-*.dump but one at the start of each run.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/restore/'

# 2. Stop the backends so nothing writes during the restore
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend

# 3. Restore (drops and recreates objects inside the existing database).
#    Use /backups/vaalikone-<stamp>.dump for the local one.
#    --single-transaction makes it all or nothing: on the first error
#    pg_restore stops and rolls back, and the database is left as it was.
#    Until it commits, the old tables' files stay on disk next to the new
#    ones, so it needs free space for a second copy of the data.
#    If it fails, read the first "pg_restore: error:" line:
#    - The dump is truncated or corrupt ("could not read from input file",
#      "could not uncompress data", "possibly corrupt archive", "does not
#      appear to be a valid archive"): fetch another dump (step 1) and
#      repeat this step with it.
#    - "could not open input file": the path or <stamp> is wrong; fix it
#      and repeat.
#    - "deadlock detected": the nightly backup was running; repeat once it
#      has finished.
#    - "No space left on device": free disk space (above) and repeat.
#    - "other objects depend on it": a migration newer than the dump added
#      a table that references the dumped ones. Every older dump fails the
#      same way, so trying another won't help.
#    To give up, go on to step 4: the backends restart on the unchanged data.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore --clean --if-exists --single-transaction -d "$DATABASE_URL" /backups/restore/vaalikone-<stamp>.dump'

# 4. Restart backends (they re-run migrations idempotently on start)
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend

# 5. Remove the fetched dump; nightly retention does not look in restore/
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rm -rf /backups/restore
```

Sanity check after restore: `curl -s localhost:3000/api/health` from a backend
container, then spot-check `SELECT count(*) FROM candidates;` matches expectations.

## Restore drill

Run this before the election (it's on the runbook checklist), so a broken dump
or a broken restore step shows up while nothing is at stake. It restores the
newest bucket dump into a scratch database, `restore_drill`, next to the live
one: the backends keep running and the live database isn't touched.

```bash
# 1. Print the newest dump's <stamp> and fetch it as in step 1 above.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone lsf "upcloud:$BACKUP_BUCKET/postgres/" | sort | tail -n 1 | sed "s/^vaalikone-//; s/\.dump\$//"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/restore/'

# 2. Restore it into a fresh scratch database with step 3's flags, so a
#    dump that step 3 would reject fails here too, then restore it again:
#    the second pass runs into a populated database, so its --clean drops
#    run as they do in step 3. The DROP clears a restore_drill left over from
#    an interrupted drill. ${DATABASE_URL%/*} is the server URL without the
#    database name (the URL has no ?query part).
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS restore_drill WITH (FORCE)"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "CREATE DATABASE restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore --clean --if-exists --single-transaction -d "${DATABASE_URL%/*}/restore_drill" /backups/restore/vaalikone-<stamp>.dump'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore --clean --if-exists --single-transaction -d "${DATABASE_URL%/*}/restore_drill" /backups/restore/vaalikone-<stamp>.dump'

# 3. Compare with the live database: the counts should match up to the day's
#    changes since the dump.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "${DATABASE_URL%/*}/restore_drill" -c "SELECT count(*) FROM candidates"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "SELECT count(*) FROM candidates"'

# 4. Clean up. Also after a failed drill.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS restore_drill WITH (FORCE)"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rm -rf /backups/restore
```
