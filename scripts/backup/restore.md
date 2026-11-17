# Restoring a Postgres backup

Dumps are `pg_dump -Fc` custom-format archives named `vaalikone-<UTC stamp>.dump`.
The newest one is always in the `backup_data` volume (`/backups` inside the
backup container); older ones live in the object-storage bucket under `postgres/`.

Keep the restore clear of 03:00 UTC: the nightly backup would dump a half-restored database, keep it as the only local dump and upload it.

```bash
# 1. Fetch a dump from the bucket if the local one isn't the version you need.
#    Into /backups/restore/, not /backups/: backup.sh deletes every
#    /backups/vaalikone-*.dump but one at the start of each run.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/restore/

# 2. Stop the backends so nothing writes during the restore
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend

# 3. Restore (drops and recreates objects inside the existing database).
#    Use /backups/vaalikone-<stamp>.dump for the local one.
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  pg_restore --clean --if-exists -d "$DATABASE_URL" /backups/restore/vaalikone-<stamp>.dump

# 4. Restart backends (they re-run migrations idempotently on start)
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend

# 5. Remove the fetched dump; nightly retention does not look in restore/
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rm -rf /backups/restore
```

Sanity check after restore: `curl -s localhost:3000/api/health` from a backend
container, then spot-check `SELECT count(*) FROM candidates;` matches expectations.
