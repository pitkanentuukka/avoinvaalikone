// The backend container only sees the variables docker-compose.yml lists under
// its `environment:` (no env_file, and .dockerignore keeps .env out of the
// image), so an operator dial the docs tell you to set in .env must be listed.
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
