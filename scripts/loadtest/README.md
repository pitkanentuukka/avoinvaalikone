# Load testing (k6)

`voter-flow.js` simulates the real voter session: fetch question sets, answer,
POST a match, open two candidate details. At full ramp it produces ~500 req/s
(125 iterations/s × ~4 requests), which is the election-day design target.

## Running locally

```bash
docker compose --profile dev up --build -d
npm run seed                      # needs seeded questions + candidate answers
k6 run -e BASE_URL=http://localhost scripts/loadtest/voter-flow.js
```

In development (`NODE_ENV` ≠ production) rate limits are skipped, so the
single-IP k6 run is not throttled.

## Running against the server (prod mode)

Run k6 **on the server itself against `http://localhost`** (through the
frontend nginx), or from a second host pointed directly at Caddy. Raise the
match rate limit for the duration of the test, since all k6 traffic comes from
one IP:

```bash
RATE_LIMIT_MATCH_MAX=100000   # in .env / compose env, then restart backend
```

**Never load-test through Cloudflare** (`https://avoinvaalikone.fi`): you would
mostly measure Cloudflare's cache, and the traffic pattern can trip its DDoS /
bot mitigation against your own IP.

## Thresholds

- error rate < 1%
- p95 < 300 ms for `GET /api/question-sets` and `GET /api/candidates/:id`
- p95 < 800 ms for `POST /api/voter/match`

## Cloudflare cache rule (manual, one-time)

Cloudflare does not cache JSON by default. In the Cloudflare dashboard create
one Cache Rule for the zone:

- **Match:** hostname equals `avoinvaalikone.fi` AND
  (URI path starts with `/api/question-sets` OR URI path starts with `/api/candidates`)
- **Cache eligibility:** Eligible for cache
- **Edge TTL:** Respect origin headers

The backend sends `Cache-Control: public, s-maxage=300` on the public GET
endpoints and `Cache-Control: no-store` on party-token and admin routes, so
only the intended responses are cached. POST requests are never cached by
Cloudflare.

Staleness window is ≤5 minutes. If an admin change must be visible immediately,
purge manually: Cloudflare dashboard → Caching → Purge by URL.
