# Restoring a Postgres backup

Dumps are `pg_dump -Fc` custom-format archives named `vaalikone-<UTC stamp>.dump`.
The newest one is always in the `backup_data` volume (`/backups` inside the
backup container); older ones live in the object-storage bucket under `postgres/`.

Keep the restore clear of 03:00 UTC: the nightly backup would dump a half-restored database, keep it as the only local dump and upload it.

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
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore --clean --if-exists -d "$DATABASE_URL" /backups/restore/vaalikone-<stamp>.dump'

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
# 1. Pick the newest dump in the bucket and fetch it as in step 1 above.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone lsf "upcloud:$BACKUP_BUCKET/postgres/" | sort | tail -n 1'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/restore/'

# 2. Restore it into a fresh scratch database, with step 3's flags plus
#    --exit-on-error so a bad dump stops the drill. The DROP clears a
#    restore_drill left over from an interrupted drill. ${DATABASE_URL%/*} is
#    the server URL without the database name (the URL has no ?query part).
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "CREATE DATABASE restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore --clean --if-exists --exit-on-error -d "${DATABASE_URL%/*}/restore_drill" /backups/restore/vaalikone-<stamp>.dump'

# 3. Compare with the live database: the counts should match up to the day's
#    changes since the dump.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "${DATABASE_URL%/*}/restore_drill" -c "SELECT count(*) FROM candidates"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "SELECT count(*) FROM candidates"'

# 4. Clean up. Also after a failed drill.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "DROP DATABASE restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rm -rf /backups/restore
```
