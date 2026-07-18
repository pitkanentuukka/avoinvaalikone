# Backup sidecar: pg_dump (matches the postgres:16 server major) + rclone,
# driven by busybox crond. Nightly at 03:00 UTC.
FROM postgres:16-alpine

RUN apk add --no-cache rclone

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh && \
    mkdir -p /backups && \
    echo "0 3 * * * /usr/local/bin/backup.sh" > /etc/crontabs/root

CMD ["crond", "-f", "-l", "8"]
