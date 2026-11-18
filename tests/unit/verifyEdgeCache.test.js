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
case "$STUB_CF_KEY" in
  path) key=\${url%%\\?*} ;;
  dynamic) reply DYNAMIC ;;
  *) key=$url ;;
esac
if grep -qxF "$key" "$STUB_DIR/cache" 2>/dev/null; then reply HIT; fi
echo "$key" >> "$STUB_DIR/cache"
reply MISS
`;

const URL = "https://example.test/api/question-sets";

function run(cfKey, probe = "", style = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-edge-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "requests"), "");
    const res = spawnSync("bash", [SCRIPT, "example.test"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, STUB_CF_KEY: cfKey, STUB_PROBE: probe, STUB_STYLE: style },
      encoding: "utf8",
    });
    const requests = fs.readFileSync(path.join(dir, "requests"), "utf8").split("\n").filter(Boolean);
    return { ...res, requests };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("passes when the cache rule ignores the query string", () => {
  const res = run("path");
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  expect(res.requests).toHaveLength(3);
  expect(res.requests.slice(0, 2)).toEqual([URL, URL]);
  expect(res.requests[2].startsWith(`${URL}?`)).toBe(true);
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
  ["connect503", "HTTP_503"],
  ["network", "MISSING"],
  ["DYNAMIC", "DYNAMIC"],
  ["BYPASS", "BYPASS"],
])("a probe answering %s fails without blaming the cache key", (probe, status) => {
  const res = run("path", probe);
  expect(res.status).toBe(1);
  expect(res.stdout).toContain(`new query string: ${status}\n`);
  expect(res.stderr).not.toMatch(/cache key includes/);
  expect(res.stderr).toMatch(/couldn't be checked/);
});

test("fails when the cache key still includes the query string", () => {
  const res = run("url");
  expect(res.status).toBe(1);
  expect(res.stdout).toContain("new query string: MISS\n");
  expect(res.stderr).toMatch(/cache key includes the query string/);
});

test("the query-string probe uses a fresh query each run", () => {
  const a = run("path").requests.filter((u) => u.includes("?"));
  const b = run("path").requests.filter((u) => u.includes("?"));
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]).not.toBe(b[0]);
});

test("still reports a missing cache rule", () => {
  const res = run("dynamic");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(/Cache Rule is missing/);
});
