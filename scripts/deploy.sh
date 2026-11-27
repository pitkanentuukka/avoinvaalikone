#!/bin/sh
# Builds and (re)starts production. Runs on the server after the tree has
# been rsynced to /opt/vaalikone: CI's deploy step calls it through
# deploy-detached.sh, and so should a manual deploy (docs/runbook.md).
set -eu
cd "$(dirname "$0")/.."

# One deploy at a time, and no rsync into the tree while one runs (#205):
# CI's rsync takes the same lock (its --rsync-path in
# .github/workflows/ci-cd.yml). The lock is on the tree's directory, which
# every deploying user can open; a lock file in a shared directory such as
# /var/lock would make root's open fail when another user created it
# (fs.protected_regular). Every command below inherits fd 9, so the lock is
# held until the script ends.
exec 9<.
if ! flock -n 9; then
  echo "Waiting for another deploy (or rsync) into $PWD to finish"
  if ! flock -w "${DEPLOY_LOCK_WAIT:-600}" 9; then
    echo "Gave up: another deploy is still running in $PWD (see \"Deploy fails\" in docs/runbook.md)" >&2
    exit 1
  fi
fi
# Names the holder in its log (docs/runbook.md). lslocks doesn't: the lock
# was taken by a flock process that has ended.
echo "Got the deploy lock"

dc="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

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

# Compose's default pull policy is `missing`: without these the server kept
# the digest it first pulled of every tag (the service images and the build
# stages' bases), and never got their Alpine, OpenSSL, Node, nginx,
# PostgreSQL or Caddy patches (#216). Neither stops a running container.
# A failed pull (Docker Hub down, or rate-limiting the server) only warns:
# the images already here keep serving, and a fix shouldn't wait on Docker
# Hub. The warnings start with `::warning::` so that CI, which follows this
# log, shows them on the run's summary.
if ! $dc pull --ignore-buildable; then
  echo "::warning::Pulling the service images failed: deploying with the copies already on the server (see \"Deploy warns\" in docs/runbook.md)"
fi
# No way to pull the bases but carry on without them, so on a failure build
# again with the bases already here. A build that fails for its own reasons
# fails that way too, and stops the deploy before `up`.
if ! $dc build --pull; then
  echo "::warning::Building on freshly pulled base images failed: building on the base images already on the server (see \"Deploy warns\" in docs/runbook.md)"
  $dc build
fi

# Validate the deployed Caddyfile on the Caddy image `up` is about to run,
# in a fresh container that mounts the new file (and publishes no ports).
# Either can be new: rsync replaced the file, and the pull may have brought a
# newer Caddy. A Caddyfile that Caddy rejects would otherwise crash-loop it
# and take the whole site down, while failing here leaves the old caddy, and
# the rest of the old deploy, serving.
$dc run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

$dc up -d
remove_mailpit

# `up -d` leaves caddy running when only the Caddyfile changed, and
# `caddy reload` wouldn't help: rsync replaces the file, and the single-file
# bind mount keeps the old one. So restart caddy (a second or so offline)
# whenever the Caddyfile it runs differs from the deployed one; a container
# that isn't running counts as different.
if ! $dc exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - Caddyfile; then
  echo "Caddyfile changed: restarting caddy"
  $dc restart caddy
fi

# Each refresh, and each rebuild, leaves the previous image untagged; nothing
# else removes them. Dangling only, and never one a container still uses.
# Housekeeping: the deploy has already happened.
if ! docker image prune -f >/dev/null; then
  echo "::warning::\`docker image prune\` failed, so the replaced images stay on disk (the deploy itself succeeded)"
fi
