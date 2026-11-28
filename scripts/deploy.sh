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

# Time limits, in whole seconds (with_timeout below): a pull stalled on
# Docker Hub, or a build, would otherwise hold the deploy lock indefinitely.
# Checked here, as a value the watchdog can't read would leave no limit.
pull_limit=${DEPLOY_PULL_TIMEOUT:-300}
build_limit=${DEPLOY_BUILD_TIMEOUT:-900}
for limit in "$pull_limit" "$build_limit"; do
  case $limit in
    "" | *[!0-9]* | 0*)
      echo "DEPLOY_PULL_TIMEOUT and DEPLOY_BUILD_TIMEOUT are whole seconds, more than 0 (got \"$limit\")" >&2
      exit 1
      ;;
  esac
done

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

# Stop on a config Compose refuses (a .env without SMTP_HOST, a YAML error)
# with Compose's own message, before the pulls below could blame Docker Hub
# for it.
$dc config -q

# Compose's default pull policy is `missing`: without these the server kept
# the digest it first pulled of each service image (db, redis, caddy), and
# of a base image already tagged here (postgres:16-alpine, which the backup
# image builds on), and never got their Alpine, OpenSSL, PostgreSQL or Caddy
# patches (#216). Neither stops a running container, but `up` then recreates
# each service whose image moved: db, redis and caddy too, for a few seconds
# each. DEPLOY_PULL=0, in the environment or in .env, skips the refresh, for
# a freeze such as election night (docs/runbook.md). Of the service images:
# the build may still resolve its bases at Docker Hub (below).
#
# A failed or stalled pull (Docker Hub down, or rate-limiting the server)
# only warns: the images already here keep serving, and a fix shouldn't wait
# on Docker Hub. The warnings start with `::warning::` so that CI, which
# follows this log, shows them on the run's summary.
#
# The build stages' bases are pulled with `docker pull` too, so that each is
# tagged here: BuildKit doesn't tag the images it fetches itself. When Docker
# Hub can't be reached at all, the build then falls back to that copy. When it
# answers but a transfer fails (rate limited, too slow), BuildKit can still
# go for the newer image itself and fail the build, before `up`. These are
# the Dockerfiles of the images Compose builds (the build contexts in
# docker-compose*.yml).
dockerfiles="Dockerfile vaalikone-frontend/Dockerfile scripts/backup/Dockerfile"
# Each FROM's image, skipping its options (--platform=…), earlier stages of
# the same file (FROM … AS build, then FROM build; names ignore case), and
# what isn't a registry image: scratch, an ARG, a continued line.
base_images() {
  awk '
    FNR == 1 { split("", stage) }
    toupper($1) == "FROM" {
      i = 2
      while (i <= NF && $i ~ /^--/) i++
      if (i <= NF && !(tolower($i) in stage) && tolower($i) != "scratch" && $i !~ /[$\\]/) print $i
      if (toupper($(i + 1)) == "AS") stage[tolower($(i + 2))] = 1
    }
  ' $dockerfiles | sort -u
}

# Every process below $1, children before theirs.
descendants() {
  for child in $(pgrep -P "$1"); do
    echo "$child"
    descendants "$child"
  done
}
# Runs "$@" with a time limit of $1 (whole) seconds: then TERM to it and
# everything it started (the docker CLI runs Compose as a child, Compose may
# run buildx), and KILL 10 seconds later. Its status is the command's, or
# that of the signal that stopped it. Not timeout(1): that catches SIGHUP,
# which nohup (deploy-detached.sh) set to be ignored, so a hangup would stop
# the deploy. A background job here keeps the ignored SIGHUP. The watchdog
# polls rather than sleeping out the limit, so that it ends with the command
# and leaves no sleep behind. It signals only what is still below the
# command: a child that outlived it isn't found (docker's don't: the CLI
# waits for Compose, and Compose stops its own on TERM). Between the
# command's end and the next poll, its PID could in theory be reused; 0.1 s
# against pid_max makes that practically impossible.
with_timeout() {
  limit=$1
  shift
  "$@" &
  cmd=$!
  (
    term=$(($(date +%s) + limit))
    while kill -0 "$cmd" 2>/dev/null; do
      now=$(date +%s)
      if [ "$now" -ge "$((term + 10))" ]; then
        kill -KILL "$cmd" $(descendants "$cmd") 2>/dev/null || true
      elif [ "$now" -ge "$term" ] && [ -z "${stopping:-}" ]; then
        echo "Gave up after ${limit}s: $*" >&2
        kill -TERM "$cmd" $(descendants "$cmd") 2>/dev/null || true
        stopping=1
      fi
      sleep 0.1
    done
  ) &
  watchdog=$!
  status=0
  wait "$cmd" || status=$?
  wait "$watchdog" || true
  return "$status"
}

# Unquoted, any case, and without what may surround it: spaces, a comment, a CR.
pull=${DEPLOY_PULL-$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}DEPLOY_PULL[[:space:]]*=[[:space:]]*[\"']\{0,1\}[[:space:]]*\([^\"'[:space:]#]*\).*/\2/p" .env 2>/dev/null | tail -n 1)}
case $(printf '%s' "$pull" | tr '[:upper:]' '[:lower:]') in
  0 | false | no | off)
    echo "::warning::DEPLOY_PULL=$pull: db, redis and caddy stay on the images already on the server, without their upstream patches (remove it when the freeze is over, docs/runbook.md)"
    ;;
  *)
    case $(printf '%s' "$pull" | tr '[:upper:]' '[:lower:]') in
      "" | 1 | true | yes | on) ;;
      *) echo "::warning::DEPLOY_PULL=$pull is neither 0 nor 1: pulling as usual" ;;
    esac
    # What this deploy starts from: the prune below deletes the images it
    # replaces, so this is where the digests that last worked are recorded
    # (docs/runbook.md, Rollback). The tags' images, and what the containers
    # run, which can differ: a deploy that failed after pulling moved a tag
    # without recreating its container.
    echo "Images before this deploy:"
    docker image ls --all --digests --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}} {{.Digest}}' || true
    echo "Containers before this deploy (name, image, image ID):"
    containers=$(docker ps -q) || true
    [ -z "$containers" ] || docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' $containers || true
    if ! with_timeout "$pull_limit" $dc pull --ignore-buildable; then
      echo "::warning::Pulling the service images failed or timed out (see the output above): deploying with the copies already on the server (see \"Deploy warns\" in docs/runbook.md)"
    fi
    for image in $(base_images); do
      if ! with_timeout "$pull_limit" docker pull "$image"; then
        echo "::warning::Pulling the base image $image failed or timed out (see the output above): the build uses the copy already on the server if Docker Hub can't be reached at all (see \"Deploy warns\" in docs/runbook.md)"
      fi
    done
    ;;
esac
if ! with_timeout "$build_limit" $dc build; then
  echo "::error::Building the images failed or timed out (see the output above): nothing was restarted (see \"Deploy fails building an image\" in docs/runbook.md)"
  exit 1
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
