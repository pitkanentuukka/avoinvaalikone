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
// "path" (query string ignored). sleep is a no-op stub.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/verify-edge-cache.sh");

const CURL_STUB = `#!/bin/sh
for a; do url=$a; done
echo "$url" >> "$STUB_DIR/requests"
case "$STUB_CF_KEY" in
  path) key=\${url%%\\?*} ;;
  dynamic) printf 'HTTP/2 200\\r\\ncf-cache-status: DYNAMIC\\r\\n\\r\\n'; exit 0 ;;
  *) key=$url ;;
esac
if grep -qxF "$key" "$STUB_DIR/cache" 2>/dev/null; then status=HIT; else status=MISS; echo "$key" >> "$STUB_DIR/cache"; fi
printf 'HTTP/2 200\\r\\ncf-cache-status: %s\\r\\n\\r\\n' "$status"
`;

function run(cfKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-edge-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), CURL_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
  const res = spawnSync("bash", [SCRIPT, "example.test"], {
    env: { PATH: `${bin}:/usr/bin:/bin`, STUB_DIR: dir, STUB_CF_KEY: cfKey },
    encoding: "utf8",
  });
  const requests = fs.readFileSync(path.join(dir, "requests"), "utf8").trim().split("\n");
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, requests };
}

test("passes when the cache rule ignores the query string", () => {
  const res = run("path");
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
});

test("fails when the cache key still includes the query string", () => {
  const res = run("url");
  expect(res.status).toBe(1);
  expect(res.stderr).toMatch(/query string/i);
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
