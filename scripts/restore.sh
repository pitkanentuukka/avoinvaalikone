#!/bin/bash
# Restore a pg_dump backup produced by backup.sh
# Usage: ./restore.sh <backup-file.sql.gz>
#
# To fetch a backup from UpCloud:  rclone ls upcloud-os:vaalikone-backups/
# To fetch a backup from B2:       rclone ls b2:vaalikone-backups/
# Then:  rclone copy upcloud-os:vaalikone-backups/<file> /opt/vaalikone/backups/
set -euo pipefail

BACKUP_FILE="${1:?Usage: $0 <backup-file.sql.gz>}"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "File not found: $BACKUP_FILE" >&2
    exit 1
fi

echo "Restoring from: $BACKUP_FILE"
echo "This will drop and recreate the vaalikone database."
echo "Backend will be stopped temporarily."
echo ""
read -r -p "Type YES to continue: " confirm
[ "$confirm" = "YES" ] || { echo "Aborted."; exit 1; }

echo "Stopping backend..."
docker stop vaalikone-backend

echo "Dropping and recreating database..."
docker exec vaalikone-db psql -U vaalikone -d postgres \
    -c "DROP DATABASE vaalikone;" \
    -c "CREATE DATABASE vaalikone OWNER vaalikone;"

echo "Restoring dump..."
gunzip -c "$BACKUP_FILE" | docker exec -i vaalikone-db psql -U vaalikone vaalikone

echo "Starting backend..."
docker start vaalikone-backend

echo "Restore complete."
