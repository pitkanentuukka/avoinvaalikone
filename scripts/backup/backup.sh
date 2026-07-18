#!/bin/sh
# Nightly Postgres backup. pg_dump custom format (compressed) to a local
# volume, then uploaded to S3-compatible object storage (UpCloud) via rclone.
# The last dump is kept locally for fast restore; remote dumps are pruned
# after 30 days. Runs from crond (see Dockerfile), or manually:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh
set -eu

LOCAL_DIR=/backups
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$LOCAL_DIR/vaalikone-$STAMP.dump"

pg_dump "$DATABASE_URL" -Fc -f "$FILE"
echo "pg_dump OK: $FILE ($(du -h "$FILE" | cut -f1))"

# Remote upload is skipped (loudly) when the bucket isn't configured, so the
# stack still runs — and keeps local dumps — before credentials are set up.
if [ -n "${BACKUP_BUCKET:-}" ]; then
  rclone copyto "$FILE" "upcloud:$BACKUP_BUCKET/postgres/$(basename "$FILE")"
  rclone delete --min-age 30d "upcloud:$BACKUP_BUCKET/postgres/"
  echo "Upload OK: $BACKUP_BUCKET/postgres/$(basename "$FILE")"
else
  echo "WARNING: BACKUP_BUCKET not set — dump kept locally only" >&2
fi

# Keep only the newest local dump (the volume is a restore cache, not an archive)
ls -1t "$LOCAL_DIR"/vaalikone-*.dump | tail -n +2 | xargs -r rm -f
