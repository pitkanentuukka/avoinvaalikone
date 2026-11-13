// The backend container only sees the variables docker-compose.yml lists under
// its `environment:`: there is no env_file, and the Dockerfile copies only
// src/ and migrations/, so .env never reaches the image. An operator dial the
// docs tell you to set in .env must therefore be listed.
const fs = require("fs");
const path = require("path");

function backendEnvironmentKeys() {
  const text = fs.readFileSync(path.join(__dirname, "../../docker-compose.yml"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  const keys = [];
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // next service
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv) {
      const m = line.match(/^ {6}([A-Z0-9_]+):/);
      if (m) keys.push(m[1]);
      else if (/^ {4}\S/.test(line)) break; // next backend key
    }
  }
  return keys;
}

describe("docker-compose.yml backend environment", () => {
  test("forwards RATE_LIMIT_MATCH_MAX, the election-night rate-limit dial", () => {
    expect(backendEnvironmentKeys()).toContain("RATE_LIMIT_MATCH_MAX");
  });

  test("still forwards the variables listed before it (parser sanity check)", () => {
    expect(backendEnvironmentKeys()).toEqual(
      expect.arrayContaining(["NODE_ENV", "PG_POOL_MAX", "PG_QUERY_TIMEOUT_MS", "SMTP_PASS"])
    );
  });
});

// log_min_duration_statement logs each slow statement with its bind
// parameters by default, and the token lookups in src/middleware/auth.js bind
// the token: a slow one (election-night load) would write a working bearer
// secret to the db container log (issue #36).
describe("docker-compose.yml db command", () => {
  function dbSettings() {
    const text = fs.readFileSync(path.join(__dirname, "../../docker-compose.yml"), "utf8");
    const db = text.slice(text.search(/^ {2}db:\s*$/m));
    const command = db.slice(0, db.search(/^ {4}environment:/m));
    return Object.fromEntries([...command.matchAll(/"-c",\s*"([a-z_]+)=([^"]*)"/g)].map((m) => [m[1], m[2]]));
  }

  test("logs slow statements (parser sanity check)", () => {
    expect(dbSettings().log_min_duration_statement).toBe("250");
  });

  test("leaves bind parameters (tokens) out of the slow-statement log", () => {
    expect(dbSettings().log_parameter_max_length).toBe("0");
  });

  // A CHECK or NOT NULL violation logs "DETAIL: Failing row contains (…)",
  // the whole row: for a candidate or party, its token. The profile UPDATE
  // relies on the constituency CHECK, so any candidate link can trigger it.
  test("leaves error DETAIL lines (failing rows, tokens) out of the log", () => {
    expect(dbSettings().log_error_verbosity).toBe("terse");
  });

  test("isn't replaced in production, where it matters", () => {
    const prod = fs.readFileSync(path.join(__dirname, "../../docker-compose.prod.yml"), "utf8");
    const db = prod.slice(prod.search(/^ {2}db:\s*$/m));
    const end = db.slice(1).search(/^ {2}\S/m);
    expect(db.slice(0, end === -1 ? undefined : end + 1)).not.toMatch(/^ {4}command:/m);
  });
});
