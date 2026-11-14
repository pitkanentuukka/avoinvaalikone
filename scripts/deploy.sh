#!/bin/sh
# Builds and (re)starts production. Runs on the server after the tree has
# been rsynced to /opt/vaalikone: CI's deploy step calls it, and so should a
# manual deploy (docs/scaling.md, docs/runbook.md).
set -eu
cd "$(dirname "$0")/.."

dc="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$dc up --build -d

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
