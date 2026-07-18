#!/usr/bin/env bash
# Verify the Cloudflare Cache Rule for /api/* JSON is actually active.
# The rule is manual dashboard state (see docs/scaling.md) — if it's deleted
# or the zone is recreated, edge caching silently stops and origin load
# multiplies. Run after every deploy and in the election-night checklist.
#
# Usage: scripts/verify-edge-cache.sh [host]   (default: avoinvaalikone.fi)
set -euo pipefail

HOST="${1:-avoinvaalikone.fi}"
URL="https://$HOST/api/question-sets"

status_of() {
  curl -fsS -o /dev/null -D - "$URL" | tr -d '\r' | grep -i '^cf-cache-status:' | awk '{print toupper($2)}'
}

first=$(status_of || echo "MISSING")
sleep 2
second=$(status_of || echo "MISSING")

echo "CF-Cache-Status: first=$first second=$second"

if [ "$second" = "HIT" ]; then
  echo "OK: edge cache is serving $URL"
  exit 0
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
