const fs = require("fs");
const path = require("path");

// Caddy has no access log here, but when a handler fails (reverse_proxy can't
// reach the frontend: a deploy or restart) it logs the error at ERROR with the
// whole request, URI and query included, so every request in flight writes
// its token (/api/candidates/me/<token>, /?candidateToken=<token>) to the
// caddy container log (issue #36). An error that a handle_errors route
// answers is logged at DEBUG instead, below Caddy's default INFO level.

const caddyfile = fs.readFileSync(path.join(__dirname, "../../Caddyfile"), "utf8")
  .replace(/#[^\n]*/g, "");

// The body of each top-level block (`name {` at column 0) by its name.
function topLevelBlocks() {
  const blocks = {};
  const re = /^(\S[^{\n]*?)\s*\{\s*$/gm;
  let m;
  while ((m = re.exec(caddyfile))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < caddyfile.length && depth > 0; i++) {
      if (caddyfile[i] === "{") depth++;
      else if (caddyfile[i] === "}") depth--;
    }
    blocks[m[1]] = caddyfile.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
  }
  return blocks;
}

test("every site answers its own errors, so Caddy doesn't log them with the URI", () => {
  const sites = Object.entries(topLevelBlocks()).filter(([name]) => name !== "");
  expect(sites.length).toBeGreaterThan(0);
  for (const [, body] of sites) {
    expect(body).toMatch(/^\s*reverse_proxy\b/m);
    expect(body).toMatch(/^\s*handle_errors\s*\{[^}]*\brespond\b[^}]*\{err\.status_code\}/m);
  }
});

test("there is no access log that would record the URI", () => {
  expect(caddyfile).not.toMatch(/^\s*log\b/m);
});
