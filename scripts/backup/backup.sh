#!/bin/sh
# Nightly Postgres backup. pg_dump custom format (compressed) to a local
# volume, then uploaded to S3-compatible object storage (UpCloud) via rclone.
# The last dump is kept locally for fast restore; remote dumps are pruned
# after 30 days. Runs from crond (see Dockerfile), or manually:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh
#
# The local volume shares the host's disk with PostgreSQL, so local retention
# runs on every path, whether or not pg_dump or the remote side works. A
# failure still exits non-zero and logs an ERROR line to stderr, which crond
# passes through to `docker compose logs backup`. pg_dump writes to a .partial
# file that is renamed only on success, so a failed dump is never mistaken for
# a backup.
set -eu

LOCAL_DIR=${BACKUP_DIR:-/backups}
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$LOCAL_DIR/vaalikone-$STAMP.dump"
PARTIAL="$FILE.partial"

# One run at a time: a manual run overlapping the cron one would otherwise
# delete the other's in-progress .partial file and its fresh dump.
exec 9>"$LOCAL_DIR/.backup.lock"
if ! flock -n 9; then
  echo "ERROR: another backup run is in progress — not starting" >&2
  exit 1
fi

# Delete every local dump except the one named. The volume is a restore
# cache, not an archive.
keep_only() {
  for f in "$LOCAL_DIR"/vaalikone-*.dump; do
    [ -e "$f" ] || continue
    [ "$f" = "$1" ] || rm -f "$f"
  done
}

# Leftovers from a run that was killed mid-dump (no chance to clean up); the
# lock guarantees no other run is still writing one.
rm -f "$LOCAL_DIR"/vaalikone-*.dump.partial

# Down to the newest existing dump before dumping, so even a disk filled by
# earlier dumps recovers and a pg_dump failure still leaves the store bounded.
# Newest by mtime: it is when a dump completed, whatever its name says.
NEWEST=$(ls -1t "$LOCAL_DIR"/vaalikone-*.dump 2>/dev/null | head -n 1 || true)
[ -z "$NEWEST" ] || keep_only "$NEWEST"

if ! pg_dump "$DATABASE_URL" -Fc -f "$PARTIAL"; then
  rm -f "$PARTIAL"
  echo "ERROR: pg_dump failed — previous local dump kept" >&2
  exit 1
fi
mv "$PARTIAL" "$FILE"
echo "pg_dump OK: $FILE ($(du -h "$FILE" | cut -f1))"
keep_only "$FILE"

status=0

# Remote upload is skipped (loudly) when the bucket isn't configured, so the
# stack still runs — and keeps a local dump — before credentials are set up.
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

exit "$status"
