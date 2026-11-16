#!/bin/sh
# Nightly Postgres backup. pg_dump custom format (compressed) to a local
# volume, then uploaded to S3-compatible object storage (UpCloud) via rclone.
# The last dump is kept locally for fast restore; remote dumps are pruned
# after 30 days. Runs from crond (see Dockerfile), or manually:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backup backup.sh
#
# The local volume shares the host's disk with PostgreSQL, so local retention
# runs on every path, whether or not pg_dump or the remote side works. Any
# failure exits non-zero and logs an "ERROR:" line to stderr, which crond
# passes through to the container log:
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backup
# pg_dump writes to a .partial file that is renamed only on success, so a
# failed dump is never mistaken for a backup.
set -eu

# fail MESSAGE: log it and exit 1. The EXIT trap covers everything else,
# i.e. aborts by set -e, which print only the shell's own message.
REPORTED=
fail() {
  echo "ERROR: $1" >&2
  REPORTED=1
  exit 1
}
trap 'rc=$?; [ "$rc" -eq 0 ] || [ -n "$REPORTED" ] || echo "ERROR: backup.sh exited with status $rc" >&2' EXIT

# BACKUP_DIR is a test hook (tests/unit/backupScript.test.js), not configuration.
LOCAL_DIR=${BACKUP_DIR:-/backups}
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$LOCAL_DIR/vaalikone-$STAMP.dump"
PARTIAL="$FILE.partial"

# One run at a time: a manual run overlapping the cron one would otherwise
# delete the other's in-progress .partial file and its fresh dump.
exec 9>"$LOCAL_DIR/.backup.lock"
flock -n 9 || fail "another backup run is in progress — not starting"

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

# Down to one existing dump before dumping, so even a disk filled by earlier
# dumps recovers and a pg_dump failure still leaves the store bounded. Keep
# the newest (by mtime: when it completed, whatever its name says) that
# pg_restore reads to the end; the script before #152 wrote dumps in place,
# so a failed run may have left a truncated one as the newest. A full read,
# not `pg_restore -l`: the header and table of contents come before the data,
# so a dump cut off mid-data still lists fine. If none reads, keep the newest
# anyway rather than delete everything.
NEWEST=$(ls -1t "$LOCAL_DIR"/vaalikone-*.dump 2>/dev/null | head -n 1 || true)
VALID=$(ls -1t "$LOCAL_DIR"/vaalikone-*.dump 2>/dev/null | while IFS= read -r f; do
  if pg_restore -f /dev/null "$f" 2>/dev/null; then printf '%s\n' "$f"; break; fi
done || true)
[ -z "$NEWEST" ] || keep_only "${VALID:-$NEWEST}"

if ! pg_dump "$DATABASE_URL" -Fc -f "$PARTIAL"; then
  rm -f "$PARTIAL"
  fail "pg_dump failed — no new dump written"
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
