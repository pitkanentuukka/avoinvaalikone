#!/bin/sh
# Builds and (re)starts production. Runs on the server after the tree has
# been rsynced to /opt/vaalikone: CI's deploy step calls it, and so should a
# manual deploy (docs/scaling.md, docs/runbook.md).
set -eu
cd "$(dirname "$0")/.."

dc="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# mailpit is dev-only (profile "dev"), but `up` without the profile leaves a
# container started before the profile existed running: it swallowed every
# email and published its web UI, magic links included (#190). Remove it with
# plain docker, by its Compose service label: every $dc call interpolates the
# prod file, so a .env missing its required SMTP variables would otherwise
# block the removal too. Again after `up`, in case COMPOSE_PROFILES=dev in .env
# started it.
remove_mailpit() {
  docker ps -aq --filter label=com.docker.compose.service=mailpit | xargs -r docker rm -f >/dev/null
}

remove_mailpit
$dc up --build -d
remove_mailpit

# `up -d` leaves caddy running when only the Caddyfile changed, and
# `caddy reload` wouldn't help: rsync replaces the file, and the single-file
# bind mount keeps the old one. So restart caddy (a second or so offline)
# whenever the Caddyfile it runs differs from the deployed one; a container
# that isn't running counts as different. Validate first, in a fresh
# container that mounts the new file: a Caddyfile the running Caddy version
# rejects would otherwise crash-loop it and take the whole site down, while
# failing here leaves the old config serving.
if ! $dc exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - Caddyfile; then
  echo "Caddyfile changed: validating, then restarting caddy"
  $dc run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  $dc restart caddy
fi
