#!/bin/sh
# Builds and (re)starts production. Runs on the server after the tree has
# been rsynced to /opt/vaalikone: CI's deploy step calls it, and so should a
# manual deploy (docs/scaling.md, docs/runbook.md).
set -eu
cd "$(dirname "$0")/.."

dc="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# One deploy at a time. CI's deploy job queues later deploys, but it gives up
# on a server that stops answering (#178), and a deploy it lost contact with
# can still be running here when the next one arrives. Wait for it (10 min,
# well inside the job's timeout) rather than run two `up --build` at once.
# DEPLOY_LOCK and DEPLOY_LOCK_WAIT are for tests.
exec 9>"${DEPLOY_LOCK:-/var/lock/vaalikone-deploy.lock}"
if ! flock -w "${DEPLOY_LOCK_WAIT:-600}" 9; then
  echo "Another deploy is still running on this server; not starting a second one." >&2
  exit 1
fi

# mailpit is dev-only (profile "dev"), but `up` without the profile leaves a
# container started before the profile existed running: it swallowed every
# email and published its web UI, magic links included (#190). Remove it with
# plain docker, by its Compose service label: every $dc call interpolates the
# prod file, so a .env missing its required SMTP variables would otherwise
# block the removal too. Again after `up`, in case COMPOSE_PROFILES=dev in .env
# started it. Found by this project's labels (named after this directory: no
# top-level `name:`), and by the base file's fixed container_name in case
# Compose named the project otherwise (COMPOSE_PROJECT_NAME in .env, name
# normalisation). No pipeline around `docker ps`: sh has no pipefail, and a
# failed `docker ps` must stop the deploy rather than skip the removal.
project=${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}
remove_mailpit() {
  by_label=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=mailpit)
  by_name=$(docker ps -aq --filter "name=^vaalikone-mailpit$")
  ids=$(printf '%s\n' $by_label $by_name | sort -u)
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
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
