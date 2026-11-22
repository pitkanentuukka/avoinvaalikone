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

Run k6 **on the server itself**, from `/opt/vaalikone`, using the production
HTTPS hostname with an explicit connection override to the local origin:
`Cloudflare bypassed → Caddy → frontend nginx → backend`. In production,
nginx has no published host port; `http://localhost` reaches Caddy with the
wrong hostname.

The checked-in [origin-local.json](origin-local.json) maps `avoinvaalikone.fi`
to `127.0.0.1` in k6, retaining the hostname for HTTP routing and TLS SNI and
certificate verification. It also sets `maxRedirects: 0`, so redirects are
reported rather than followed. Caddy must already have a valid certificate
trusted by the test host; keep TLS verification enabled. For a different
deployment hostname, update both the config key and `BASE_URL`. From a second
test host, use a separate config mapping the same hostname to the origin's
reachable IP, rather than `127.0.0.1`.

Before raising the limits or starting a load test, verify the local HTTPS route
(no redirects followed; an invalid empty match request should return the
backend's Finnish validation JSON with HTTP 400):

```bash
curl --noproxy avoinvaalikone.fi --resolve avoinvaalikone.fi:443:127.0.0.1 \
  --fail-with-body -sS https://avoinvaalikone.fi/api/question-sets
curl --noproxy avoinvaalikone.fi --resolve avoinvaalikone.fi:443:127.0.0.1 \
  -sS -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' \
  -d '{}' https://avoinvaalikone.fi/api/voter/match
```

These direct-to-origin tests omit Cloudflare. With production
`TRUST_PROXY_HOPS=3`, the shorter chain can make `req.ip` a proxy IP or derive
it from client-supplied `X-Forwarded-For`. The test measures origin capacity;
it does not validate per-client rate limiting through the full proxy chain.

Raise the match and candidate-page rate limits for the duration of the test,
since the load comes from one test host. `NO_PROXY` below ensures an HTTPS proxy from the shell's
environment cannot bypass k6's direct connection override:

```bash
# in /opt/vaalikone: raise the limits for the test (keep both -f files; not `restart`,
# which keeps the old environment). The voter flow also opens candidate pages,
# whose misses count against RATE_LIMIT_CANDIDATE_READ_MAX, all from this one host.
RATE_LIMIT_MATCH_MAX=100000 RATE_LIMIT_CANDIDATE_READ_MAX=100000 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
NO_PROXY=avoinvaalikone.fi no_proxy=avoinvaalikone.fi k6 run \
  --config scripts/loadtest/origin-local.json \
  -e BASE_URL=https://avoinvaalikone.fi scripts/loadtest/voter-flow.js
# afterwards: back to the .env value
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
```

**Never load-test through Cloudflare** (the public hostname without an origin
connection override): you would
mostly measure Cloudflare's cache, and the traffic pattern can trip its DDoS /
bot mitigation against your own IP.

The host override uses k6's [JSON configuration](https://grafana.com/docs/k6/latest/using-k6/k6-options/how-to/); see the [hosts and max redirects options](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/).

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
- **Cache key → Query string:** Ignore query string where the plan offers
  it; on the Free plan, a URL Rewrite Rule per path instead (Query: Target
  query `*`, Rewrite to empty; see docs/scaling.md). The endpoints ignore
  the query string; with the default key every new one reaches the origin
  (#159)

[docs/scaling.md](../../docs/scaling.md), "Deployment steps → 3. Create the
Cloudflare Cache Rule", is the full setup;
`scripts/verify-edge-cache.sh` checks it.

The backend sends `Cache-Control: public, s-maxage=300` on the public GET
endpoints and `Cache-Control: no-store` on party-token and admin routes, so
only the intended responses are cached. POST requests are never cached by
Cloudflare.

Staleness window is ≤5 minutes. If an admin change must be visible immediately,
purge manually: Cloudflare dashboard → Caching → Purge by URL.
