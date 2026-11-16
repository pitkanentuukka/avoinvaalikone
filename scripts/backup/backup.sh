#!/bin/sh
# Nightly Postgres backup. pg_dump custom format (compressed) to a local
# volume, then uploaded to S3-compatible object storage (UpCloud) via rclone.
# The last dump is kept locally for fast restore; remote dumps are pruned
# after 30 days. Runs from crond (see Dockerfile), or manually:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh
#
# The local volume shares the host's disk with PostgreSQL, so local retention
# runs whether or not the remote side works; a remote failure still makes the
# script exit non-zero. pg_dump writes to a .partial file that is renamed only
# on success, so a failed dump is never mistaken for the newest backup.
set -eu

LOCAL_DIR=${BACKUP_DIR:-/backups}
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$LOCAL_DIR/vaalikone-$STAMP.dump"
PARTIAL="$FILE.partial"

# Leftovers from a run that was killed mid-dump (no chance to clean up).
rm -f "$LOCAL_DIR"/vaalikone-*.dump.partial

if ! pg_dump "$DATABASE_URL" -Fc -f "$PARTIAL"; then
  rm -f "$PARTIAL"
  echo "ERROR: pg_dump failed — previous local dump kept" >&2
  exit 1
fi
mv "$PARTIAL" "$FILE"
echo "pg_dump OK: $FILE ($(du -h "$FILE" | cut -f1))"

status=0

# Remote upload is skipped (loudly) when the bucket isn't configured, so the
# stack still runs — and keeps local dumps — before credentials are set up.
if [ -n "${BACKUP_BUCKET:-}" ]; then
  REMOTE="upcloud:$BACKUP_BUCKET/postgres/$(basename "$FILE")"
  if rclone copyto "$FILE" "$REMOTE"; then
    echo "Upload OK: $BACKUP_BUCKET/postgres/$(basename "$FILE")"
    # Prune only after a successful upload: with uploads failing, age-based
    # deletion would eventually empty the bucket.
    if ! rclone delete --min-age 30d "upcloud:$BACKUP_BUCKET/postgres/"; then
      echo "ERROR: pruning old remote dumps failed" >&2
      status=1
    fi
  else
    echo "ERROR: upload to $BACKUP_BUCKET failed — dump kept locally only" >&2
    status=1
  fi
else
  echo "WARNING: BACKUP_BUCKET not set — dump kept locally only" >&2
fi

# Keep only the newest local dump (the volume is a restore cache, not an
# archive). Sorted by the UTC stamp in the name, not mtime, so the dump this
# run just completed is always the one kept.
ls -1 "$LOCAL_DIR"/vaalikone-*.dump | sort -r | tail -n +2 | xargs -r rm -f

exit "$status"
