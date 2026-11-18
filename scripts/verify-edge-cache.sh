#!/usr/bin/env bash
# Verify the Cloudflare Cache Rule for /api/* JSON is actually active, and that
# its cache key ignores the query string.
# The rule is manual dashboard state (see docs/scaling.md) — if it's deleted
# or the zone is recreated, edge caching silently stops and origin load
# multiplies. Run after every deploy and in the election-night checklist.
#
# Usage: scripts/verify-edge-cache.sh [host]   (default: avoinvaalikone.fi)
set -euo pipefail

HOST="${1:-avoinvaalikone.fi}"
URL="https://$HOST/api/question-sets"

status_of() {
  curl -fsS -o /dev/null -D - "${1:-$URL}" | tr -d '\r' | grep -i '^cf-cache-status:' | awk '{print toupper($2)}'
}

first=$(status_of || echo "MISSING")
sleep 2
second=$(status_of || echo "MISSING")

echo "CF-Cache-Status: first=$first second=$second"

if [ "$second" = "HIT" ]; then
  # The endpoints ignore the query string, so the rule's cache key must too:
  # with Cloudflare's default key, every new query string is a MISS that goes
  # to the origin (#159). A never-seen query string must hit the entry the
  # requests above just cached.
  probe=$(status_of "$URL?cache-key-check=$(date +%s)-$$-$RANDOM" || echo "MISSING")
  echo "CF-Cache-Status with a new query string: $probe"
  if [ "$probe" = "HIT" ]; then
    echo "OK: edge cache is serving $URL"
    exit 0
  fi
  echo "FAIL: a new query string missed the edge cache ($probe) — the Cache Rule's cache key includes the query string. Set Cache key → Query string → Ignore query string (docs/scaling.md)." >&2
  exit 1
fi

# First request may legitimately be MISS/EXPIRED right after a deploy or TTL
# expiry; the second must be a HIT if the Cache Rule exists.
case "$second" in
  MISSING)
    echo "FAIL: no CF-Cache-Status header — is the site behind Cloudflare (orange cloud)?" >&2 ;;
  DYNAMIC)
    echo "FAIL: Cloudflare is treating $URL as uncacheable — the Cache Rule is missing. Recreate it per docs/scaling.md." >&2 ;;
  *)
    echo "FAIL: expected HIT on second request, got $second — check the Cache Rule and origin Cache-Control headers." >&2 ;;
esac
exit 1
