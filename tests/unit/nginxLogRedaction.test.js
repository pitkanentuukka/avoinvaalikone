const fs = require("fs");
const path = require("path");

// The frontend nginx logs every request it serves, at every status: the API
// calls it proxies (/api/candidates/me/<token>, …) and the magic-link page
// loads (/?candidateToken=<token>). Its access log must mask the tokens like
// the backend's does (issue #36).
//
// nginx can't run in the unit tests, so this reads the config with nginx's
// tokenizer rules (quotes, backslash escapes, `#` comments outside quotes) and
// evaluates its `map` blocks the way nginx does: the first matching regex wins
// (`~` case-sensitive, `~*` not), its value interpolates named captures, and
// otherwise the `default`. nginx's PCRE and JavaScript agree on the regex
// syntax used here.

const T = "3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b3c4d5e6f7a8b";
const ID = "3b9d7c1e-5f2a-4e8b-9c6d-1a2b3c4d5e6f";

// Words, quoted strings (unquoted; nginx drops the backslash only before a
// quote or a backslash), and the punctuation `{`, `}`, `;`.
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if ("{};".includes(c)) { tokens.push({ punct: c }); i++; continue; }
    let word = "";
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\" && [c, "\\"].includes(text[i + 1])) i++;
        word += text[i++];
      }
      i++;
    } else {
      while (i < text.length && !/[\s{};]/.test(text[i])) word += text[i++];
    }
    tokens.push({ word });
  }
  return tokens;
}

// Directives as { name, args, block }, nested.
function parse(tokens, pos = { i: 0 }) {
  const list = [];
  let current = null;
  while (pos.i < tokens.length) {
    const t = tokens[pos.i++];
    if (t.punct === "}") break;
    if (t.punct === ";") { if (current) list.push(current); current = null; continue; }
    if (t.punct === "{") { current.block = parse(tokens, pos); list.push(current); current = null; continue; }
    if (current) current.args.push(t.word);
    else current = { name: t.word, args: [] };
  }
  return list;
}

const directives = parse(tokenize(
  fs.readFileSync(path.join(__dirname, "../../vaalikone-frontend/nginx.conf"), "utf8")
));

function findAll(name, list = directives) {
  return list.flatMap((d) => [...(d.name === name ? [d] : []), ...findAll(name, d.block ?? [])]);
}

function parseMaps() {
  return findAll("map").map(({ args, block }) => {
    const [source, target] = args.map((a) => a.replace(/^\$/, ""));
    const entries = [];
    let fallback;
    for (const { name: key, args: [value] } of block) {
      if (key === "default") fallback = value;
      else if (key.startsWith("~*")) entries.push({ re: new RegExp(key.slice(2), "i"), value });
      else if (key.startsWith("~")) entries.push({ re: new RegExp(key.slice(1)), value });
      // nginx tries exact keys before any regex, whatever their order in the
      // file; evaluate() only knows file order.
      else throw new Error(`map $${target}: exact key "${key}" isn't supported by this emulator`);
    }
    return { source, target, entries, fallback };
  });
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
      const m = input.match(entry.re);
      if (m) { out = interpolate(entry.value, { ...vars, ...m.groups }); break; }
    }
    vars[target] = out ?? interpolate(fallback ?? "", vars);
  }
  return vars;
}

function logFormats() {
  return Object.fromEntries(findAll("log_format").map(({ args: [name, ...parts] }) => [name, parts.join("")]));
}

function accessLogFormat() {
  const logs = findAll("access_log");
  expect(logs).toHaveLength(1);
  return { path: logs[0].args[0], format: logs[0].args[1] };
}

test("the tokenizer keeps `#` and `;` inside quotes, like nginx", () => {
  const [d] = parse(tokenize(`map $a $b { "~x#y;z" "v\\"w\\.q"; } # comment`));
  expect(d.block[0]).toEqual({ name: "~x#y;z", args: ['v"w\\.q'] });
});

test("the access log uses a format of nginx.conf's own", () => {
  expect(logFormats()[accessLogFormat().format]).toBeDefined();
});

test("the access log format records no raw URI, query string or Referer", () => {
  const format = logFormats()[accessLogFormat().format];
  // $request is "$request_method $request_uri $server_protocol"; $uri (alias
  // $document_uri), $request_filename and $args carry the path and query too;
  // the Referer is the previous page's URL.
  for (const raw of [
    "$request ", "$request\"", "$request_uri", "$uri", "$document_uri", "$request_filename",
    "$args", "$query_string", "$arg_", "$http_referer",
  ]) {
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
    // A query with a token param in it is dropped whole: one regex replaces
    // one match, and URLSearchParams reads the first of a repeated param.
    [`/?candidateToken=${T}`, "/?[redacted]"],
    [`/?register=${T}`, "/?[redacted]"],
    [`/?view=candidate&partyToken=${T}&candidateId=${ID}`, "/?[redacted]"],
    [`/?partyToken=${T}&candidateToken=${T}`, "/?[redacted]"],
    [`/?candidateToken=${T}&candidateToken=other`, "/?[redacted]"],
    [`/?x=1&register=${T}`, "/?[redacted]"],
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
    "/?xregister=1",
  ])("leaves %s alone", (input) => {
    expect(evaluate(input)[uriVar]).toBe(input);
  });
});

// nginx's error lines carry the raw request line ("request: GET
// /api/candidates/me/<token> …") and the upstream URL, in a format that can't
// be changed. A backend restart writes one for every proxied request in
// flight, so only levels above "error" may be logged. (Resource exhaustion
// still logs at alert/crit with the request line; see nginx.conf.)
test("the error log skips upstream and other request-level errors", () => {
  const logs = findAll("error_log");
  expect(logs).toHaveLength(1);
  expect(["crit", "alert", "emerg"]).toContain(logs[0].args[1]);
});
