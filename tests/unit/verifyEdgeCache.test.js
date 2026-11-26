// scripts/verify-edge-cache.sh checks the manual Cloudflare Cache Rule
// (docs/scaling.md) after every deploy and on election night. The public API
// reads ignore the query string, so the rule's cache key must too; otherwise
// a random query string misses the edge every time and goes to the origin
// (issue #159). The script must catch a rule that still uses the default
// cache key.
//
// curl is a stub that plays Cloudflare's edge cache: a request is a HIT when
// its cache key was seen before, else a MISS that stores the key. STUB_CF_KEY
// picks the cache key: "url" (Cloudflare's default, query string included) or
// "path" (query string ignored). STUB_PROBE makes the query-string probe
// answer a fixed CF-Cache-Status, or one of the shapes below. STUB_STYLE=http1
// answers like an HTTP/1.1 server: capitalised header name, lowercase value.
// STUB_HANG=all plays a connection that never answers (a stuck TLS handshake,
// a black-holed route): a curl given --max-time/-m "waits" that long and
// fails with curl's timeout error, else it really hangs. STUB_HANG=worst is
// the slowest run that still gets through: every request takes its whole
// limit, and the second request to each path is a HIT. sleep is a no-op
// stub.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { step } = require("../helpers/workflow");

const SCRIPT = path.join(__dirname, "../../scripts/verify-edge-cache.sh");

const PROBE_SHAPES = {
  // Origin error through an "Eligible for cache" rule: Cloudflare says MISS.
  http503: "HTTP/2 503\\r\\ncf-cache-status: MISS\\r\\n\\r\\n",
  // The same behind an HTTPS proxy: -D - also writes the CONNECT reply.
  connect503:
    "HTTP/1.1 200 Connection established\\r\\n\\r\\nHTTP/2 503\\r\\ncf-cache-status: MISS\\r\\n\\r\\n",
  // 103 Early Hints before the real (cached) response.
  hints: "HTTP/2 103\\r\\nlink: </app.js>\\r\\n\\r\\nHTTP/2 200\\r\\ncf-cache-status: HIT\\r\\n\\r\\n",
  // A cached 4xx: an error, whatever the status.
  http404: "HTTP/2 404\\r\\ncf-cache-status: HIT\\r\\n\\r\\n",
  // A status only in an earlier block: the final response has none.
  earlyStatus: "HTTP/2 103\\r\\ncf-cache-status: HIT\\r\\n\\r\\nHTTP/2 200\\r\\n\\r\\n",
};

const CURL_STUB = `#!/bin/sh
max_time= prev=
for a; do
  case "$prev" in --max-time|-m) max_time=$a ;; esac
  prev=$a url=$a
done
echo "$url" >> "$STUB_DIR/requests"
reply() {
  if [ "\${STUB_STYLE:-}" = http1 ]; then
    printf 'HTTP/1.1 200 OK\\r\\nCF-Cache-Status: %s\\r\\n\\r\\n' "$(echo "$1" | tr A-Z a-z)"
  else
    printf 'HTTP/2 200\\r\\ncf-cache-status: %s\\r\\n\\r\\n' "$1"
  fi
  exit 0
}
if [ -n "\${STUB_HANG:-}" ]; then
  # Without a limit, hang (long enough to show; not forever, so the test
  # process isn't held up by a leftover stub).
  [ -n "$max_time" ] || exec /bin/sleep 8 </dev/null >/dev/null 2>&1
  echo "$max_time" >> "$STUB_DIR/waited"
  # worst: the second request to each path answers HIT just inside its
  # limit, so the script goes on to the probe, which hangs too.
  if [ "$STUB_HANG" = worst ]; then
    case "$url" in *\\?*) ;; *)
      grep -qxF "$url" "$STUB_DIR/seen" 2>/dev/null && reply HIT
      echo "$url" >> "$STUB_DIR/seen" ;;
    esac
  fi
  echo "curl: (28) Operation timed out after \${max_time}000 milliseconds" >&2
  exit 28
fi
case "$url" in *\\?*)
  case "\${STUB_PROBE:-}" in
    "") ;;
    network) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
    connectTimeout) printf 'HTTP/1.1 200 Connection established\\r\\n\\r\\n'; echo "curl: (28) Operation timed out" >&2; exit 28 ;;
    partial) printf 'HTTP/2 200\\r\\n'; echo "curl: (28) Operation timed out" >&2; exit 28 ;;
    slowBody) printf 'HTTP/2 200\\r\\ncf-cache-status: HIT\\r\\n\\r\\n'; echo "curl: (28) Operation timed out" >&2; exit 28 ;;
${Object.entries(PROBE_SHAPES).map(([k, v]) => `    ${k}) printf '${v}'; exit 0 ;;`).join("\n")}
    *) reply "$STUB_PROBE" ;;
  esac
esac
mode=$STUB_CF_KEY
case "$url" in */api/candidates*) mode=\${STUB_CF_KEY_CANDIDATES:-$mode} ;; esac
case "$mode" in
  path) key=\${url%%\\?*} ;;
  dynamic) reply DYNAMIC ;;
  miss) reply MISS ;;
  noheader) printf 'HTTP/2 200\\r\\n\\r\\n'; exit 0 ;;
  error503) printf 'HTTP/2 503\\r\\ncf-cache-status: DYNAMIC\\r\\n\\r\\n'; exit 0 ;;
  *) key=$url ;;
esac
if grep -qxF "$key" "$STUB_DIR/cache" 2>/dev/null; then reply HIT; fi
echo "$key" >> "$STUB_DIR/cache"
reply MISS
`;

const URL = "https://example.test/api/question-sets";
const CANDIDATES = "https://example.test/api/candidates";

// candidatesKey: the cache key for /api/candidates* only (on the Free plan
// each path has its own rewrite rule, which can be missing on its own).
// extraEnv: more stub settings (STUB_HANG).
function run(cfKey, probe = "", style = "", candidatesKey = "", extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-edge-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), '#!/bin/sh\necho "sleep $*" >> "$STUB_DIR/requests"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "requests"), "");
    const res = spawnSync("bash", [SCRIPT, "example.test"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, STUB_CF_KEY: cfKey, STUB_PROBE: probe, STUB_STYLE: style, STUB_CF_KEY_CANDIDATES: candidatesKey, ...extraEnv },
      encoding: "utf8",
      // A hung script is killed here rather than hanging the test run
      // (only where a hang is being tested: a loaded runner can be slow).
      timeout: extraEnv.STUB_HANG ? 5000 : undefined,
    });
    // Requests and sleeps, in order; `requests` is the requests alone.
    const events = fs.readFileSync(path.join(dir, "requests"), "utf8").split("\n").filter(Boolean);
    const requests = events.filter((e) => !e.startsWith("sleep "));
    // Seconds each timed-out request "waited", and the script's own sleeps.
    const waitedFile = path.join(dir, "waited");
    const waited = fs.existsSync(waitedFile)
      ? fs.readFileSync(waitedFile, "utf8").split("\n").filter(Boolean).map(Number)
      : [];
    const slept = events.filter((e) => e.startsWith("sleep ")).map((e) => Number(e.slice(6)));
    return { ...res, events, requests, waited, slept };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("passes when the edge ignores the query string on both paths", () => {
  const res = run("path");
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  expect(res.requests).toHaveLength(6);
  expect(res.requests.slice(0, 2)).toEqual([URL, URL]);
  expect(res.requests[2].startsWith(`${URL}?`)).toBe(true);
  expect(res.requests.slice(3, 5)).toEqual([CANDIDATES, CANDIDATES]);
  expect(res.requests[5].startsWith(`${CANDIDATES}?`)).toBe(true);
  expect(res.stdout).toContain(`OK: edge cache is serving ${URL} and ${CANDIDATES}, whatever the query string`);
  // The pause lets the edge store the entry before the second request.
  expect(res.events.map((e) => e.replace(/\?.*/, "?…"))).toEqual([
    URL, "sleep 2", URL, `${URL}?…`, CANDIDATES, "sleep 2", CANDIDATES, `${CANDIDATES}?…`,
  ]);
});

test("a question-sets failure doesn't stop the candidate list's check", () => {
  const res = run("url", "", "", "path");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(new RegExp(`query string on ${URL} missed`));
  expect(res.stderr).not.toMatch(new RegExp(`${CANDIDATES}\\b`));
  expect(res.requests).toHaveLength(6);
  expect(res.stdout).not.toContain("OK:");
});

test("both missing rewrite rules are reported in one run", () => {
  const res = run("url");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(new RegExp(`query string on ${URL} missed`));
  expect(res.stderr).toMatch(new RegExp(`query string on ${CANDIDATES} missed`));
});

// Review round 5: the candidate list gets the same two-request check, so a
// Cache Rule that doesn't cover it, or an erroring origin, is reported as
// such rather than as an inconclusive probe.
test.each([
  ["dynamic", /Cloudflare is treating .*\/api\/candidates as uncacheable — the Cache Rule is missing or doesn't cover this path/],
  ["error503", /\/api\/candidates answered 503: the origin or the edge is erroring/],
  ["miss", /expected HIT on the second request to .*\/api\/candidates, got MISS/],
  ["noheader", /no CF-Cache-Status header on .*\/api\/candidates/],
])("a candidate list answering %s is diagnosed, without a probe", (key, message) => {
  const res = run("path", "", "", key);
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(message);
  expect(res.requests).toHaveLength(5);
  expect(res.requests.at(-1)).toBe(CANDIDATES);
});

// Review round 4: with one rewrite rule per path on the Free plan, the
// candidates rule can be missing while the question-sets one works.
test("fails when only the candidate list's query string reaches the cache key", () => {
  const res = run("path", "", "", "url");
  expect(res.status).toBe(1);
  expect(res.stdout).toContain(`CF-Cache-Status for ${CANDIDATES} with a new query string: MISS\n`);
  expect(res.stderr).toMatch(new RegExp(`query string on ${CANDIDATES} missed`));
});

// The entry can expire between the second request and the probe; a stale
// entry found for a never-seen query string still proves it is ignored.
test.each(["UPDATING", "EXPIRED", "REVALIDATED", "STALE"])(
  "a probe that finds the entry %s also passes",
  (status) => {
    const res = run("path", status);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  }
);

test("passes with HTTP/1.1-style headers", () => {
  const res = run("path", "", "http1");
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
});

// Review round 2 (#178): a timeout after the headers arrived (a slow body)
// doesn't throw away what they say.
test("headers that arrived before a timeout still count", () => {
  const res = run("path", "slowBody");
  expect(res.stdout).toMatch(/new query string: HIT\n/);
  expect(res.status).toBe(0);
});

test("a 103 Early Hints block before the response is skipped", () => {
  const res = run("path", "hints");
  expect(res.stdout).toMatch(/new query string: HIT\n/);
  expect(res.status).toBe(0);
});

test.each([
  ["http503", "HTTP_503"],
  ["http404", "HTTP_404"],
  ["earlyStatus", "MISSING"],
  ["connect503", "HTTP_503"],
  ["network", "NO_RESPONSE"],
  // Behind a proxy: its CONNECT reply, then nothing from the site.
  ["connectTimeout", "NO_RESPONSE"],
  // The final response's headers cut off partway.
  ["partial", "NO_RESPONSE"],
  ["DYNAMIC", "DYNAMIC"],
  ["BYPASS", "BYPASS"],
])("a probe answering %s fails without blaming the cache key", (probe, status) => {
  const res = run("path", probe);
  expect(res.status).toBe(1);
  expect(res.stdout).toContain(`new query string: ${status}\n`);
  expect(res.stderr).not.toMatch(/reaches the cache key/);
  expect(res.stderr).toMatch(/couldn't be checked/);
});

test("fails when the cache key still includes the query string", () => {
  const res = run("url");
  expect(res.status).toBe(1);
  expect(res.stdout).toContain("new query string: MISS\n");
  expect(res.stderr).toMatch(/query string still reaches the cache key/);
});

test("the query-string probe uses a fresh query each run", () => {
  const a = run("path").requests.filter((u) => u.includes("?"));
  const b = run("path").requests.filter((u) => u.includes("?"));
  expect(a).toHaveLength(2);
  expect(b).toHaveLength(2);
  expect(new Set([...a, ...b]).size).toBe(4);
});

test("still reports a missing cache rule, without probing the cache key", () => {
  const res = run("dynamic");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(/Cache Rule is missing/);
  // Both paths are checked, neither probed.
  expect(res.requests).toEqual([URL, URL, CANDIDATES, CANDIDATES]);
});

test("an erroring site is reported as such, not as a cache rule problem", () => {
  const res = run("error503");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(/answered 503: the origin or the edge is erroring/);
  expect(res.stderr).not.toMatch(/Cache Rule/);
  expect(res.stdout).toContain("second=HTTP_503");
  // Both paths are checked, neither probed.
  expect(res.requests).toEqual([URL, URL, CANDIDATES, CANDIDATES]);
});

// Issue #178: the deploy job runs this script after every deploy, and every
// later deploy queues behind it (concurrency: deploy-production, no
// cancel-in-progress). A connection that never answers must not hold the
// step: each request gives up, and all of them together finish well inside
// the step's own timeout, which is the backstop (its settings are checked in
// deployWorkflowTimeouts.test.js).
describe("a connection that never answers (#178)", () => {
  test("every request gives up, and the script fails saying so", () => {
    const res = run("path", "", "", "", { STUB_HANG: "all" });
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.waited).toHaveLength(res.requests.length);
    expect(res.stdout).toContain("first=NO_RESPONSE second=NO_RESPONSE");
    expect(res.stderr).toMatch(/request to .*\/api\/question-sets failed before a CF-Cache-Status header arrived \(timed out or unreachable/);
    expect(res.stderr).toMatch(/request to .*\/api\/candidates failed before a CF-Cache-Status header arrived \(timed out or unreachable/);
    // Not mistaken for a Cloudflare configuration problem.
    expect(res.stderr).not.toMatch(/Cloudflare|Cache Rule/);
  });

  test("a probe that gets no response is inconclusive, not a cache-key failure", () => {
    const res = run("path", "", "", "", { STUB_HANG: "worst" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("new query string: NO_RESPONSE\n");
    expect(res.stderr).toMatch(/couldn't be checked/);
    expect(res.stderr).not.toMatch(/reaches the cache key/);
  });

  test("the slowest possible run fits well inside the time the step gives it", () => {
    const s = step("deploy", "Verify edge cache");
    // The step runs the script under `timeout N`, inside its timeout-minutes.
    const limit = Number(s.run.match(/\btimeout (\d+) bash scripts\/verify-edge-cache\.sh\b/)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(s["timeout-minutes"] * 60);
    const res = run("path", "", "", "", { STUB_HANG: "worst" });
    // Every request the script can make, each taking its whole limit.
    expect(res.requests).toHaveLength(6);
    expect(res.waited).toHaveLength(6);
    const total = [...res.waited, ...res.slept].reduce((a, b) => a + b, 0);
    // Room to spare for the runner and bash itself.
    expect(total).toBeLessThanOrEqual(limit * 0.75);
  });
});
