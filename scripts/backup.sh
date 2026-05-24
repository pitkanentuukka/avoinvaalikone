#!/bin/bash
# Daily PostgreSQL backup: local rotation + UpCloud Object Storage + Backblaze B2
set -euo pipefail

BACKUP_DIR="/opt/vaalikone/backups"
DATE=$(date +%Y-%m-%d_%H%M%S)
FILENAME="vaalikone_${DATE}.sql.gz"
KEEP_DAYS=7
ERRORS=0

mkdir -p "$BACKUP_DIR"

log() { echo "[$(date -Iseconds)] $*"; }
warn() { log "WARNING: $*"; ERRORS=$((ERRORS + 1)); }

log "Starting backup: $FILENAME"

docker exec vaalikone-db pg_dump -U vaalikone vaalikone | gzip > "$BACKUP_DIR/$FILENAME"
SIZE=$(du -h "$BACKUP_DIR/$FILENAME" | cut -f1)
log "Dump complete (${SIZE})"

find "$BACKUP_DIR" -name "vaalikone_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete
log "Local rotation done (keeping ${KEEP_DAYS} days)"

if rclone copy "$BACKUP_DIR/$FILENAME" upcloud-os:vaalikone-backups/; then
    log "Uploaded to UpCloud Object Storage"
else
    warn "UpCloud Object Storage upload failed"
fi

if rclone copy "$BACKUP_DIR/$FILENAME" b2:vaalikone-backups/; then
    log "Uploaded to Backblaze B2"
else
    warn "Backblaze B2 upload failed"
fi

if [ "$ERRORS" -gt 0 ]; then
    log "Backup finished with $ERRORS warning(s) — check output above"
    exit 1
fi

log "Backup complete"
