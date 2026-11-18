# Backup sidecar: pg_dump (matches the postgres:16 server major) + rclone,
# driven by busybox crond. Nightly at 03:00 UTC.
FROM postgres:16-alpine

# backup.sh serialises runs with flock (busybox applet); fail the build, not
# the nightly run, if the base image ever stops shipping it. The unit tests
# run with the host's flock, so this is the only check of the image's one.
RUN apk add --no-cache rclone && command -v flock

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh && \
    mkdir -p /backups && \
    echo "0 3 * * * /usr/local/bin/backup.sh" > /etc/crontabs/root

CMD ["crond", "-f", "-l", "8"]
