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
// sleep is a no-op stub.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
for a; do url=$a; done
echo "$url" >> "$STUB_DIR/requests"
reply() {
  if [ "\${STUB_STYLE:-}" = http1 ]; then
    printf 'HTTP/1.1 200 OK\\r\\nCF-Cache-Status: %s\\r\\n\\r\\n' "$(echo "$1" | tr A-Z a-z)"
  else
    printf 'HTTP/2 200\\r\\ncf-cache-status: %s\\r\\n\\r\\n' "$1"
  fi
  exit 0
}
case "$url" in *\\?*)
  case "\${STUB_PROBE:-}" in
    "") ;;
    network) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
${Object.entries(PROBE_SHAPES).map(([k, v]) => `    ${k}) printf '${v}'; exit 0 ;;`).join("\n")}
    *) reply "$STUB_PROBE" ;;
  esac
esac
mode=$STUB_CF_KEY
case "$url" in */api/candidates*) mode=\${STUB_CF_KEY_CANDIDATES:-$mode} ;; esac
case "$mode" in
  path) key=\${url%%\\?*} ;;
  dynamic) reply DYNAMIC ;;
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
function run(cfKey, probe = "", style = "", candidatesKey = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-edge-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "requests"), "");
    const res = spawnSync("bash", [SCRIPT, "example.test"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, STUB_CF_KEY: cfKey, STUB_PROBE: probe, STUB_STYLE: style, STUB_CF_KEY_CANDIDATES: candidatesKey },
      encoding: "utf8",
    });
    const requests = fs.readFileSync(path.join(dir, "requests"), "utf8").split("\n").filter(Boolean);
    return { ...res, requests };
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
});

test("a question-sets failure ends the check before the candidate list", () => {
  const res = run("url", "", "", "path");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(new RegExp(`query string on ${URL} missed`));
  expect(res.requests).toHaveLength(3);
  expect(res.stdout).not.toContain("OK:");
});

// Review round 5: the candidate list gets the same two-request check, so a
// Cache Rule that doesn't cover it, or an erroring origin, is reported as
// such rather than as an inconclusive probe.
test.each([
  ["dynamic", /Cloudflare is treating .*\/api\/candidates as uncacheable — the Cache Rule is missing or doesn't cover this path/],
  ["error503", /\/api\/candidates answered 503: the origin or the edge is erroring/],
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
  ["network", "MISSING"],
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
  expect(res.requests).toHaveLength(2);
});

test("an erroring site is reported as such, not as a cache rule problem", () => {
  const res = run("error503");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(/answered 503: the origin or the edge is erroring/);
  expect(res.stderr).not.toMatch(/Cache Rule/);
  expect(res.stdout).toContain("second=HTTP_503");
  expect(res.requests).toHaveLength(2);
});
