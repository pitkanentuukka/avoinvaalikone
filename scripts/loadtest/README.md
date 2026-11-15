# Load testing (k6)

`voter-flow.js` simulates the real voter session: fetch question sets, answer,
POST a match, open two candidate details. At full ramp it produces ~500 req/s
(125 iterations/s × ~4 requests), which is the election-day design target.

## Running locally

```bash
NODE_ENV=development docker compose --profile dev up --build -d
npm run seed                      # needs seeded questions + candidate answers
k6 run -e BASE_URL=http://localhost scripts/loadtest/voter-flow.js
```

All rate limits are skipped when the backend's `NODE_ENV` is not `production`.
Check this setting before a local run: Compose defaults an unset or empty
`NODE_ENV` to `production`, even with `--profile dev` (that profile only starts
Mailpit). The command above explicitly sets `NODE_ENV=development` so the
single-IP k6 run is not throttled at the default 300 match requests/minute.
For a plain `npm run dev` stack, use a `.env` copied from `.env.example` or
explicitly set `NODE_ENV=development` as well.

## Running against the server (prod mode)

Run k6 **on the server itself against `http://localhost`** (through the
frontend nginx), or from a second host pointed directly at Caddy. Raise the
match rate limit for the duration of the test, since all k6 traffic comes from
one IP:

```bash
# in /opt/vaalikone: raise the limit for the test (keep both -f files; not `restart`,
# which keeps the old environment)
RATE_LIMIT_MATCH_MAX=100000 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
# afterwards: back to the .env value
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
```

These direct-to-origin tests omit the Cloudflare hop. With production
`TRUST_PROXY_HOPS=3`, the shorter proxy chain means `req.ip` can be a proxy IP
or come from a client-supplied `X-Forwarded-For` header. Raising the limit is
sufficient for a capacity test, but its rate-limit numbers do not validate
per-client enforcement through the full production proxy chain.

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
