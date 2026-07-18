# Restoring a Postgres backup

Dumps are `pg_dump -Fc` custom-format archives named `vaalikone-<UTC stamp>.dump`.
The newest one is always in the `backup_data` volume (`/backups` inside the
backup container); older ones live in the object-storage bucket under `postgres/`.

```bash
# 1. Fetch a dump from the bucket if the local one isn't the version you need
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  rclone copy "upcloud:$BACKUP_BUCKET/postgres/vaalikone-<stamp>.dump" /backups/

# 2. Stop the backends so nothing writes during the restore
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop backend

# 3. Restore (drops and recreates objects inside the existing database)
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup \
  pg_restore --clean --if-exists -d "$DATABASE_URL" /backups/vaalikone-<stamp>.dump

# 4. Restart backends (they re-run migrations idempotently on start)
docker compose -f docker-compose.yml -f docker-compose.prod.yml start backend
```

Sanity check after restore: `curl -s localhost:3000/api/health` from a backend
container, then spot-check `SELECT count(*) FROM candidates;` matches expectations.
