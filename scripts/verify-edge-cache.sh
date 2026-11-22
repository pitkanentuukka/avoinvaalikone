#!/usr/bin/env bash
# Verify the Cloudflare Cache Rule for /api/* JSON is actually active, and that
# the edge ignores the query string on both cached paths (the Cache Rule's
# cache key, or on the Free plan the URL Rewrite Rules; docs/scaling.md).
# This is manual dashboard state — if it's deleted or the zone is recreated,
# edge caching silently stops and origin load multiplies. Run after every
# deploy and in the election-night checklist.
#
# Usage: scripts/verify-edge-cache.sh [host]   (default: avoinvaalikone.fi)
set -euo pipefail

HOST="${1:-avoinvaalikone.fi}"
URL="https://$HOST/api/question-sets"
CANDIDATES_URL="https://$HOST/api/candidates"

# Every request gives up on its own: the deploy job runs this after each
# deploy and later deploys queue behind it, so a connection that never answers
# (a stuck TLS handshake, a black-holed route) must not hold it (#178). The
# six requests at most 10 s each, plus the two pauses, stay well inside the
# step's timeout-minutes in .github/workflows/ci-cd.yml.
CURL_LIMITS=(--connect-timeout 5 --max-time 10)

# Prints the response's CF-Cache-Status, HTTP_<code> for an HTTP error, or
# MISSING when there is no header (or no response at all, as when the request
# timed out); always one word.
# -D - can write several header blocks (a proxy's CONNECT reply, a 103 Early
# Hints); each status line starts a new one, so only the final response's
# block counts.
status_of() {
  { curl -sS "${CURL_LIMITS[@]}" -o /dev/null -D - "${1:-$URL}" || true; } | tr -d '\r' |
    awk 'BEGIN { s = "MISSING" }
         /^HTTP\// { code = $2; s = "MISSING" }
         tolower($1) == "cf-cache-status:" { s = toupper($2) }
         END { if (code + 0 >= 400) s = "HTTP_" code; print s }'
}

# The endpoints ignore the query string, so the edge must too: with
# Cloudflare's default cache key, every new query string is a MISS that goes
# to the origin (#159). A never-seen query string on $1 must hit the entry a
# request just cached. If that entry expired in between, the probe finds it
# stale (UPDATING, EXPIRED, …), which proves the same thing.
probe_query_string() {
  local url=$1 probe
  probe=$(status_of "$url?cache-key-check=$(date +%s)-$$-$RANDOM")
  echo "CF-Cache-Status for $url with a new query string: $probe"
  case "$probe" in
    HIT|UPDATING|STALE|REVALIDATED|EXPIRED)
      return 0 ;;
    MISS)
      echo "FAIL: a new query string on $url missed the edge cache — the query string still reaches the cache key. Set the Cache Rule's Cache key → Query string → Ignore query string, or on the Free plan add the URL Rewrite Rule for this path that drops it (docs/scaling.md, \"3. Create the Cloudflare Cache Rule\")." >&2 ;;
    *)
      echo "FAIL: the query-string check on $url got $probe, so the cache key couldn't be checked; run the script again." >&2 ;;
  esac
  return 1
}

# Two requests to $1, 2 s apart: the first may legitimately be MISS/EXPIRED
# right after a deploy or TTL expiry, the second must be a HIT if the Cache
# Rule covers $1.
check_cached() {
  local url=$1 first second
  first=$(status_of "$url")
  sleep 2
  second=$(status_of "$url")
  echo "CF-Cache-Status for $url: first=$first second=$second"
  case "$second" in
    HIT)
      return 0 ;;
    MISSING)
      echo "FAIL: no CF-Cache-Status header on $url — is the site behind Cloudflare (orange cloud)?" >&2 ;;
    DYNAMIC)
      echo "FAIL: Cloudflare is treating $url as uncacheable — the Cache Rule is missing or doesn't cover this path. Recreate it (and on the Free plan the URL Rewrite Rules) per docs/scaling.md." >&2 ;;
    HTTP_*)
      echo "FAIL: $url answered ${second#HTTP_}: the origin or the edge is erroring (or blocking this client), so the cache couldn't be checked." >&2 ;;
    *)
      echo "FAIL: expected HIT on the second request to $url, got $second — check the Cache Rule and origin Cache-Control headers." >&2 ;;
  esac
  return 1
}

# Both paths: on the Free plan each has its own URL Rewrite Rule, and the
# Cache Rule's expression names each path. Each is checked even if the other
# failed, so one run reports every rule that needs fixing.
rc=0
for url in "$URL" "$CANDIDATES_URL"; do
  if check_cached "$url"; then
    probe_query_string "$url" || rc=1
  else
    rc=1
  fi
done
[ "$rc" -eq 0 ] || exit 1
echo "OK: edge cache is serving $URL and $CANDIDATES_URL, whatever the query string"
