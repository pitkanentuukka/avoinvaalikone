# Restoring a Postgres backup

Dumps are `pg_dump -Fc` custom-format archives named `vaalikone-<UTC stamp>.dump`.
The newest one is always in the `backup_data` volume (`/backups` inside the
backup container); older ones live in the object-storage bucket under `postgres/`.

Keep the restore clear of 03:00 UTC. A nightly backup that is already running
makes step 3 wait until it finishes. One that starts during step 3 waits for it
and then fails ("cache lookup failed for relation"), since the tables it set out
to dump are gone, so that night has no new dump. After the restore, check the 03:00 backup log
(`docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backup`), or
run backup.sh by hand (`docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh`).

```bash
# BACKUP_BUCKET and DATABASE_URL are set only inside the backup container, so
# the commands that use them run under sh -c '…': the single quotes stop the
# host shell from expanding them (to nothing) first.

# 1. Put the dump to restore in /backups/restore/, not /backups/: backup.sh
#    deletes every /backups/vaalikone-*.dump but one at the start of each
#    run. For the local dump, copy it there instead of fetching it:
#      docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
#        sh -c 'mkdir -p /backups/restore && cp /backups/vaalikone-<stamp>.dump /backups/restore/'
#    Otherwise fetch it from the bucket:
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/restore/'

# 2. Stop the backends so nothing writes during the restore
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend

# 3. Restore: replace everything in the database's public schema with the
#    dump. It is all or nothing; a failure leaves the database as it was.
#    - pg_restore first writes the whole dump out as SQL, to restore.sql.
#      A truncated or corrupt dump fails there, before the database is
#      touched. Don't pipe pg_restore into psql instead: psql would take
#      the early end of its input as the end of the restore and commit
#      what had arrived.
#    - psql then drops the public schema with everything in it, recreates
#      it with initdb's owner and grants, and runs restore.sql, all in one
#      transaction (-1 with ON_ERROR_STOP): on the first error it stops and
#      rolls back.
#      Dropping the whole schema also removes tables that a migration newer
#      than the dump added, which pg_restore --clean would leave in place
#      and fail on (#233). Step 4 recreates them, empty.
#    restore.sql is about the size of the data, and until psql commits the
#    old tables' files stay on disk next to the new ones, so it needs free
#    space for two copies of the data, plus up to 1 GB (max_wal_size) of WAL.
#    On success it prints nothing.
#    If it fails, read the first error: a "pg_restore: error:" line, or a
#    psql line with "ERROR:" or "FATAL:".
#    - "PANIC", "crash of another server process", "server closed the
#      connection unexpectedly" or "connection to server was lost":
#      Postgres crashed, most likely on a full disk while writing WAL (look
#      for PANIC in
#      `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs db`).
#      It recovers to the unchanged data, but the aborted restore's files
#      can stay on disk, so free more space than the estimate above and
#      repeat.
#    - The dump is truncated or corrupt ("could not read from input file",
#      "could not uncompress data", "possibly corrupt archive", "input file
#      does not appear to be a valid archive", "input file is too short"):
#      fetch another dump (step 1) and repeat this step with it.
#    - "could not open input file", or "directory ... does not appear to be
#      a valid archive": the path or <stamp> is wrong. Fix it and repeat,
#      fetching the right dump first (step 1) if the stamp was wrong there.
#    - "deadlock detected": the nightly backup was running; repeat once it
#      has finished.
#    - "No space left on device": free at least the space estimated above
#      and repeat.
#    To give up, go on to step 4: the backends restart on the unchanged data.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore -f /backups/restore/restore.sql /backups/restore/vaalikone-<stamp>.dump &&
    psql -q -o /dev/null -1 -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -c "DROP SCHEMA public CASCADE" \
      -c "CREATE SCHEMA public AUTHORIZATION pg_database_owner" -c "GRANT USAGE ON SCHEMA public TO PUBLIC" \
      -f /backups/restore/restore.sql "$DATABASE_URL"'

# 4. Restart backends (they re-run migrations idempotently on start)
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend

# 5. Remove the fetched dump and restore.sql, which holds everything the
#    dump does; nightly retention does not look in restore/
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

# 2. Restore it into a fresh scratch database with step 3's command, so a
#    dump that step 3 would reject fails here too. Then add a table that
#    references candidates, as a migration newer than the dump would, and
#    restore again: the second pass runs into a populated database, as step
#    3 does, and fails if that table is in the way (#233). The first DROP clears a
#    restore_drill left over from an interrupted drill. ${DATABASE_URL%/*}
#    is the server URL without the database name (the URL has no ?query
#    part).
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS restore_drill WITH (FORCE)"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "$DATABASE_URL" -c "CREATE DATABASE restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore -f /backups/restore/restore.sql /backups/restore/vaalikone-<stamp>.dump &&
    psql -q -o /dev/null -1 -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -c "DROP SCHEMA public CASCADE" \
      -c "CREATE SCHEMA public AUTHORIZATION pg_database_owner" -c "GRANT USAGE ON SCHEMA public TO PUBLIC" \
      -f /backups/restore/restore.sql "${DATABASE_URL%/*}/restore_drill"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'psql "${DATABASE_URL%/*}/restore_drill" -c "CREATE TABLE drill_newer (candidate_id uuid REFERENCES candidates)"'
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  sh -c 'pg_restore -f /backups/restore/restore.sql /backups/restore/vaalikone-<stamp>.dump &&
    psql -q -o /dev/null -1 -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" -c "DROP SCHEMA public CASCADE" \
      -c "CREATE SCHEMA public AUTHORIZATION pg_database_owner" -c "GRANT USAGE ON SCHEMA public TO PUBLIC" \
      -f /backups/restore/restore.sql "${DATABASE_URL%/*}/restore_drill"'

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
