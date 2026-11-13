const fs = require("fs");
const path = require("path");

// The frontend nginx logs every request it serves, at every status: the API
// calls it proxies (/api/candidates/me/<token>, …) and the magic-link page
// loads (/?candidateToken=<token>). Its access log must mask the tokens like
// the backend's does (issue #36).
//
// nginx can't run in the unit tests, so this evaluates the config's `map`
// blocks the way nginx does: the first matching regex wins (`~` case-
// sensitive, `~*` not), its value interpolates named captures, and otherwise
// the `default`. nginx's PCRE and JavaScript agree on the syntax used here.

const conf = fs.readFileSync(path.join(__dirname, "../../vaalikone-frontend/nginx.conf"), "utf8")
  // Drop comments so commented-out directives don't count.
  .replace(/#[^\n]*/g, "");

const T = "3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b3c4d5e6f7a8b";
const ID = "3b9d7c1e-5f2a-4e8b-9c6d-1a2b3c4d5e6f";

function unquote(s) {
  return /^".*"$/.test(s) ? s.slice(1, -1) : s;
}

function parseMaps() {
  const maps = [];
  for (const [, source, target, body] of conf.matchAll(/map\s+\$(\w+)\s+\$(\w+)\s*\{([^}]*)\}/g)) {
    const entries = [];
    let fallback;
    for (const line of body.split(";").map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(\S+|"[^"]*")\s+(.+)$/);
      const key = unquote(m[1]);
      const value = unquote(m[2].trim());
      if (key === "default") fallback = value;
      else if (key.startsWith("~*")) entries.push({ re: new RegExp(key.slice(2), "i"), value });
      else if (key.startsWith("~")) entries.push({ re: new RegExp(key.slice(1)), value });
      else entries.push({ exact: key, value });
    }
    maps.push({ source, target, entries, fallback });
  }
  return maps;
}

function interpolate(value, vars) {
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    const name = a || b;
    if (!(name in vars)) throw new Error(`nginx.conf map value uses unknown variable $${name}`);
    return vars[name] ?? "";
  });
}

// Runs the maps in order, so a map may read the target of an earlier one.
function evaluate(requestUri) {
  const vars = { request_uri: requestUri };
  for (const { source, target, entries, fallback } of parseMaps()) {
    const input = vars[source];
    if (input === undefined) throw new Error(`map reads $${source}, which isn't defined before it`);
    let out;
    for (const entry of entries) {
      if (entry.exact !== undefined) {
        if (entry.exact === input) { out = interpolate(entry.value, vars); break; }
        continue;
      }
      const m = input.match(entry.re);
      if (m) { out = interpolate(entry.value, { ...vars, ...m.groups }); break; }
    }
    vars[target] = out ?? interpolate(fallback ?? "", vars);
  }
  return vars;
}

function logFormats() {
  const formats = {};
  for (const [, name, body] of conf.matchAll(/log_format\s+(\w+)\s+((?:'[^']*'\s*)+);/g)) {
    formats[name] = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]).join("");
  }
  return formats;
}

function accessLogFormat() {
  const m = conf.match(/access_log\s+(\S+)\s+(\w+)\s*;/);
  return m && { path: m[1], format: m[2] };
}

test("the access log uses a format of nginx.conf's own", () => {
  const log = accessLogFormat();
  expect(log).not.toBeNull();
  expect(logFormats()[log.format]).toBeDefined();
});

test("the access log format records no raw URI, query string or Referer", () => {
  const format = logFormats()[accessLogFormat().format];
  // $request is "$request_method $request_uri $server_protocol"; $uri and $args
  // carry the path and query too; the Referer is the previous page's URL.
  for (const raw of ["$request ", "$request\"", "$request_uri", "$uri", "$args", "$query_string", "$arg_", "$http_referer"]) {
    expect(format).not.toContain(raw);
  }
});

describe("the URI the access log records", () => {
  let uriVar;
  beforeAll(() => {
    const format = logFormats()[accessLogFormat().format];
    const vars = Object.keys(evaluate("/"));
    uriVar = vars.find((v) => v !== "request_uri" && format.includes(`$${v}`));
    expect(uriVar).toBeDefined();
  });

  test.each([
    [`/api/candidates/me/${T}`, "/api/candidates/me/[token]"],
    [`/api/candidates/register/${T}`, "/api/candidates/register/[token]"],
    [`/api/candidates/party/${T}/candidates/${ID}/send-link`, `/api/candidates/party/[token]/candidates/${ID}/send-link`],
    [`/api/candidates/ME/${T}`, "/api/candidates/ME/[token]"],
    [`/api/candidates/me/${T}?x=1`, "/api/candidates/me/[token]?x=1"],
    [`/?candidateToken=${T}`, "/?candidateToken=[token]"],
    [`/?register=${T}`, "/?register=[token]"],
    [`/?view=candidate&partyToken=${T}&candidateId=${ID}`, `/?view=candidate&partyToken=[token]&candidateId=${ID}`],
    [`/?partyToken=${T}&candidateToken=${T}`, "/?partyToken=[token]&candidateToken=[token]"],
  ])("masks %s", (input, expected) => {
    expect(evaluate(input)[uriVar]).toBe(expected);
  });

  test.each([
    "/",
    "/assets/index-abc123.js",
    `/api/candidates/${ID}`,
    "/api/candidates?constituency=Lapin%20vaalipiiri",
    "/api/voter/match",
    "/?registered=1",
  ])("leaves %s alone", (input) => {
    expect(evaluate(input)[uriVar]).toBe(input);
  });
});
