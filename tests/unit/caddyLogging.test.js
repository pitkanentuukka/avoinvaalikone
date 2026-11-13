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
  const sites = Object.entries(topLevelBlocks());
  expect(sites.length).toBeGreaterThan(0);
  for (const [, body] of sites) {
    expect(body).toMatch(/^\s*reverse_proxy\b/m);
    expect(body).toMatch(/^\s*handle_errors\s*\{[^}]*\brespond\b[^}]*\{err\.status_code\}/m);
  }
});

test("no site has an access log that would record the URI", () => {
  for (const body of Object.values(topLevelBlocks())) {
    expect(body).not.toMatch(/^\s*log\b/m);
  }
});

// The global options block: the first `{` at column 0.
function globalOptions() {
  const start = caddyfile.search(/^\{\s*$/m);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < caddyfile.length; i++) {
    if (caddyfile[i] === "{") depth++;
    else if (caddyfile[i] === "}" && --depth === 0) return caddyfile.slice(start + 1, i);
  }
  throw new Error("unterminated global options block");
}

// reverse_proxy logs a response cut off mid-body ("aborting with incomplete
// response") above INFO, and current Caddy versions attach the request, URI
// included. handle_errors can't catch it: the handler panics instead.
test("the default log leaves out reverse_proxy's own messages", () => {
  expect(globalOptions()).toMatch(/^\s*log\s+default\s*\{[^}]*^\s*exclude\b[^\n]*\bhttp\.handlers\.reverse_proxy(?=\s|$)/m);
});

// At DEBUG, the errors handle_errors answers are logged again, with the URI.
test("nothing turns on debug logging", () => {
  expect(globalOptions()).not.toMatch(/^\s*debug\s*$/m);
  expect(caddyfile).not.toMatch(/^\s*level\s+debug\b/im);
});
