// The backend container only sees the variables docker-compose.yml lists under
// its `environment:`: there is no env_file, and the Dockerfile copies only
// src/ and migrations/, so .env never reaches the image. An operator dial the
// docs tell you to set in .env must therefore be listed.
const fs = require("fs");
const path = require("path");

// The `environment:` mapping of one service in a compose file, as written
// (values unparsed, e.g. '"true"' or '${VAR:-}').
function environmentOf(file, service) {
  const text = fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^ {2}${service}:\\s*$`).test(l));
  expect(start).toBeGreaterThan(-1);
  const env = {};
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // next service
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv) {
      const m = line.match(/^ {6}([A-Z0-9_]+):\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
      else if (/^ {4}\S/.test(line)) break; // next key of the service
    }
  }
  return env;
}

const backendEnvironmentKeys = () => Object.keys(environmentOf("docker-compose.yml", "backend"));

describe("docker-compose.yml backend environment", () => {
  test("forwards RATE_LIMIT_MATCH_MAX, the election-night rate-limit dial", () => {
    expect(backendEnvironmentKeys()).toContain("RATE_LIMIT_MATCH_MAX");
  });

  // Every limit the backend reads with limitFromEnv() is a dial the docs tell
  // operators to set in .env (and to raise for load tests).
  test("forwards every rate-limit variable the backend reads", () => {
    const fs = require("fs");
    const path = require("path");
    const src = path.join(__dirname, "../../src");
    const names = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith(".js")) {
          for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/limitFromEnv\("([A-Z_]+)"/g)) names.add(name);
        }
      }
    };
    walk(src);
    expect([...names].sort()).toEqual(["RATE_LIMIT_CANDIDATE_READ_MAX", "RATE_LIMIT_LIST_READ_MAX", "RATE_LIMIT_MATCH_MAX"]);
    expect(backendEnvironmentKeys()).toEqual(expect.arrayContaining([...names]));
  });

  // .env isn't in the image (.dockerignore), so a variable missing here never
  // reaches the container: SMTP_MAX_CONNECTIONS, which .env.example offers for
  // a throttling provider, was always the default 3 under Compose (#214).
  test("forwards every SMTP_* variable src/email.js reads", () => {
    const text = fs.readFileSync(path.join(__dirname, "../../src/email.js"), "utf8");
    const names = new Set([...text.matchAll(/process\.env\.(SMTP_[A-Z_]+)/g)].map(([, name]) => name));
    for (const [, list] of text.matchAll(/const \{([^}]+)\} = process\.env/g)) {
      for (const name of list.split(",").map((n) => n.trim())) if (name.startsWith("SMTP_")) names.add(name);
    }
    expect(names).toContain("SMTP_MAX_CONNECTIONS");
    expect(backendEnvironmentKeys()).toEqual(expect.arrayContaining([...names]));
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

// docker-compose.yml defaults SMTP_HOST to the dev-only mailpit service, which
// production never starts. Without its own SMTP settings, a production deploy
// sent every email to a leftover mailpit container (recorded as "sent", readable
// on its published web UI) or to a host that doesn't resolve (issue #190).
describe("docker-compose.prod.yml email", () => {
  const prod = () => fs.readFileSync(path.join(__dirname, "../../docker-compose.prod.yml"), "utf8");

  function serviceBlock(text, name) {
    const start = text.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
    if (start === -1) return "";
    const rest = text.slice(start + 1);
    const end = rest.search(/^ {2}\S/m);
    return text.slice(start, end === -1 ? undefined : start + 1 + end);
  }

  test.each(["SMTP_HOST", "SMTP_FROM"])("requires %s instead of inheriting the dev default", (key) => {
    expect(serviceBlock(prod(), "backend")).toMatch(new RegExp(`^ {6}${key}: \\$\\{${key}:\\?[^}]+\\}\\s*$`, "m"));
  });

  // The base file's SMTP_PORT default is mailpit's 1025; a provider set up
  // with only the required host and sender would be dialled on 1025.
  test("doesn't inherit mailpit's port 1025", () => {
    expect(serviceBlock(prod(), "backend")).toMatch(/^ {6}SMTP_PORT: \$\{SMTP_PORT:-587\}\s*$/m);
  });

  // .env.example is what operators copy to .env, and SMTP_FROM's ":?" can't
  // tell a copied example sender from a real one.
  test.each([".env.example", "docker-compose.yml", "src/email.js"])(
    "%s doesn't default the sender to a real domain this deployment doesn't control",
    (file) => {
      const text = fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
      expect(text).not.toMatch(/noreply@vaalikone\.fi/);
    }
  );

  test("never publishes mailpit's ports, even if someone starts it there", () => {
    expect(serviceBlock(prod(), "mailpit")).toMatch(/^ {4}ports: !reset \[\]\s*$/m);
  });
});

// Without this call nothing reports an unreachable SMTP server until a send
// fails (#190); the call itself only runs when the server starts.
test("src/index.js verifies SMTP once the server is listening", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/index.js"), "utf8");
  const listen = src.slice(src.indexOf("app.listen("));
  expect(listen.slice(0, listen.indexOf("});"))).toMatch(/^\s+verifySmtp\(\);$/m);
});

// rclone's S3 backend calls CreateBucket before an upload unless
// no_check_bucket is set. The backup key is scoped to the one bucket, which is
// created by hand, so every nightly upload failed with 403 and the dump stayed
// on the host only (issue #194).
describe("docker-compose.prod.yml backup", () => {
  // Every rclone remote backup.sh uploads to or prunes ("<remote>:$BACKUP_BUCKET").
  function backupRemotes() {
    const script = fs.readFileSync(path.join(__dirname, "../../scripts/backup/backup.sh"), "utf8");
    return [...new Set([...script.matchAll(/([a-z0-9_]+):\$BACKUP_BUCKET/g)].map((m) => m[1]))];
  }

  test("backup.sh uses a remote (parser sanity check)", () => {
    expect(backupRemotes()).toEqual(["upcloud"]);
  });

  test("tells rclone not to create the bucket, for the remote backup.sh uses", () => {
    const env = environmentOf("docker-compose.prod.yml", "backup");
    for (const remote of backupRemotes()) {
      expect(env[`RCLONE_CONFIG_${remote.toUpperCase()}_NO_CHECK_BUCKET`]).toBe('"true"');
    }
  });
});
