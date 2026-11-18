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

# Prints the response's CF-Cache-Status, HTTP_<code> for an HTTP error, or
# MISSING when there is no header (or no response at all); always one word.
# -D - can write several header blocks (a proxy's CONNECT reply, a 103 Early
# Hints); each status line starts a new one, so only the final response's
# block counts.
status_of() {
  { curl -sS -o /dev/null -D - "${1:-$URL}" || true; } | tr -d '\r' |
    awk 'BEGIN { s = "MISSING" }
         /^HTTP\// { code = $2; s = "MISSING" }
         tolower($1) == "cf-cache-status:" { s = toupper($2) }
         END { if (code + 0 >= 400) s = "HTTP_" code; print s }'
}

first=$(status_of)
sleep 2
second=$(status_of)

echo "CF-Cache-Status: first=$first second=$second"

if [ "$second" = "HIT" ]; then
  # The endpoints ignore the query string, so the rule's cache key must too:
  # with Cloudflare's default key, every new query string is a MISS that goes
  # to the origin (#159). A never-seen query string must hit the entry the
  # requests above just cached. If that entry expired in between, the probe
  # finds it stale (UPDATING, EXPIRED, …), which proves the same thing.
  probe=$(status_of "$URL?cache-key-check=$(date +%s)-$$-$RANDOM")
  echo "CF-Cache-Status with a new query string: $probe"
  case "$probe" in
    HIT|UPDATING|STALE|REVALIDATED|EXPIRED)
      echo "OK: edge cache is serving $URL, whatever the query string"
      exit 0 ;;
    MISS)
      echo "FAIL: a new query string missed the edge cache — the Cache Rule's cache key includes the query string. Set Cache key → Query string → Ignore query string (docs/scaling.md)." >&2 ;;
    *)
      echo "FAIL: the query-string check got $probe, so the cache key couldn't be checked; run the script again." >&2 ;;
  esac
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
