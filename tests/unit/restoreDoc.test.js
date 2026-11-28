// scripts/backup/restore.md is followed by hand during an outage, so its
// commands must work as written (issue #163). BACKUP_BUCKET and DATABASE_URL
// are set only inside the backup container (docker-compose.prod.yml); the
// operator's host shell normally has neither, or a stale copy, so they must
// expand inside the container, not in the host shell before
// `docker compose exec` runs.
//
// The test runs the doc's bash blocks under /bin/sh with a stub `docker` that
// behaves like `docker compose exec <service> <argv…>`: it runs argv directly
// (no shell, as exec does) with the backup container's environment, and runs
// `sh` as busybox sh, the container's shell, when busybox is installed.
// rclone, pg_restore, psql and rm are stubs that record their arguments, and
// whether they ran inside the "container"; nothing real is touched. What the
// restore does to a real database is tests/routes/restoreRunbook.test.js.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DOC = path.join(__dirname, "../../scripts/backup/restore.md");
const STAMP = "20261101-030000"; // backup.sh: date -u +%Y%m%d-%H%M%S
const DUMP = `/backups/restore/vaalikone-${STAMP}.dump`;
const SQL = "/backups/restore/restore.sql";
const BUCKET = "container-bucket";
const LIVE = "postgresql://vaalikone:pw@db:5432/vaalikone";
const DRILL = "postgresql://vaalikone:pw@db:5432/restore_drill";
const COMPOSE_FILES = ["-f", "docker-compose.yml", "-f", "docker-compose.prod.yml"];

// The first bash block in a section: "" is the part under the `# ` title,
// before the first `## ` heading.
function blockIn(markdown, heading) {
  const sections = markdown.split(/^## /m);
  const section = heading === "" ? sections[0] : sections.find((s) => s.startsWith(heading));
  const m = section && section.match(/```bash\n([\s\S]*?)```/);
  if (!m) throw new Error(`no bash block in section "${heading}"`);
  return m[1];
}

// Records "== <name> <container|host>", then argv one per line, in $STUB_LOG.
// The tool named in $STUB_FAIL then exits 1.
const RECORDER = `#!/bin/sh
{ echo "== $(basename "$0") \${STUB_IN_CONTAINER:-host}"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
[ "$(basename "$0")" != "\${STUB_FAIL:-}" ]
`;

// docker compose [-f …]… exec <service> <argv…>: run argv with the
// container's environment in place of the host's.
const DOCKER_STUB = `#!/bin/sh
{ echo "== docker host"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
while [ $# -gt 0 ] && [ "$1" != exec ]; do shift; done
[ $# -eq 0 ] && exit 0
shift 2
if [ "$1" = sh ] && command -v busybox > /dev/null; then shift; set -- busybox sh "$@"; fi
exec env STUB_IN_CONTAINER=container BACKUP_BUCKET="$STUB_BUCKET" DATABASE_URL="$STUB_DB_URL" "$@"
`;

function runBlock(block, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-doc-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const name of ["rclone", "pg_restore", "psql", "rm"]) {
      fs.writeFileSync(path.join(bin, name), RECORDER, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
    const log = path.join(dir, "log");
    fs.writeFileSync(log, "");

    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_LOG: log,
      STUB_BUCKET: BUCKET,
      STUB_DB_URL: LIVE,
      // A stale copy in the operator's shell must not win either.
      BACKUP_BUCKET: "host-bucket",
      DATABASE_URL: "postgresql://host/wrong",
      ...extraEnv,
    };
    const script = block.replaceAll("<stamp>", STAMP);
    const res = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
    const calls = fs
      .readFileSync(log, "utf8")
      .split(/^== /m)
      .filter(Boolean)
      .map((chunk) => {
        const [head, ...args] = chunk.replace(/\n$/, "").split("\n");
        const [name, where] = head.split(" ");
        return { name, where, args };
      });
    return { res, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The connection URL among a psql call's arguments.
function dbTarget(call) {
  return call.args.find((a) => /^postgresql:\/\//.test(a));
}

// The values of every `flag <value>` pair in a call, in order.
function values(call, flag) {
  return call.args.flatMap((a, i) => (a === flag ? [call.args[i + 1]] : []));
}

const markdown = fs.readFileSync(DOC, "utf8");
const runs = {
  restore: runBlock(blockIn(markdown, "")),
  drill: runBlock(blockIn(markdown, "Restore drill")),
};
const pgRestore = (name) => runs[name].calls.find((c) => c.name === "pg_restore");
// The psql calls that run the SQL pg_restore wrote.
const psqlRestores = (name) => runs[name].calls.filter((c) => c.name === "psql" && c.args.includes("-f"));

describe.each(Object.keys(runs))("%s block", (name) => {
  const { res, calls } = runs[name];
  const of = (tool) => calls.filter((c) => c.name === tool);

  test("runs as written", () => {
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });

  test("every docker command uses both compose files", () => {
    const docker = of("docker");
    expect(docker.length).toBeGreaterThan(0);
    for (const c of docker) {
      expect(c.args.slice(0, 5)).toEqual(["compose", ...COMPOSE_FILES]);
    }
  });

  test("every container command goes to the backup service", () => {
    const services = of("docker")
      .filter((c) => c.args.includes("exec"))
      .map((c) => c.args[c.args.indexOf("exec") + 1]);
    expect(new Set(services)).toEqual(new Set(["backup"]));
  });

  test("rclone, pg_restore, psql and rm run only inside the container", () => {
    const tools = calls.filter((c) => c.name !== "docker");
    expect(tools.length).toBeGreaterThan(0);
    for (const c of tools) expect(c.where).toBe("container");
  });

  test("rclone reads the bucket configured in the backup container", () => {
    const rclone = of("rclone");
    expect(rclone.length).toBeGreaterThan(0);
    for (const c of rclone) {
      expect(c.args[1]).toMatch(new RegExp(`^upcloud:${BUCKET}/postgres/`));
    }
    expect(rclone.filter((c) => c.args[0] === "copy").map((c) => c.args)).toEqual([
      ["copy", `upcloud:${BUCKET}/postgres/vaalikone-${STAMP}.dump`, "/backups/restore/"],
    ]);
  });

  test("pg_restore reads the fetched dump", () => {
    expect(of("pg_restore").length).toBeGreaterThan(0);
    for (const c of of("pg_restore")) expect(c.args.at(-1)).toBe(DUMP);
  });

  test("the fetched dump is removed at the end", () => {
    expect(of("rm").map((c) => c.args)).toEqual([["-rf", "/backups/restore"]]);
    expect(calls.at(-1).name).toBe("rm");
  });
});

// Each call as one string: the tool, then its db target or docker subcommand.
function sequence(name) {
  return runs[name].calls.map((c) => {
    if (c.name === "docker") {
      const i = c.args.findIndex((a) => ["exec", "stop", "start"].includes(a));
      return `docker ${c.args[i]} ${c.args[i + 1]}`;
    }
    if (c.name === "psql") {
      return c.args.includes("-f") ? `psql ${dbTarget(c)} -f ${values(c, "-f")}` : `psql ${dbTarget(c)} ${values(c, "-c")}`;
    }
    if (c.name === "pg_restore") return `pg_restore -f ${values(c, "-f")}`;
    return `${c.name} ${c.args[0]}`;
  }).filter((step) => !step.startsWith("docker exec"));
}

test("the restore runs its steps in order, with the backends stopped", () => {
  expect(sequence("restore")).toEqual([
    "rclone copy",
    "docker stop backend",
    `pg_restore -f ${SQL}`,
    `psql ${LIVE} -f ${SQL}`,
    "docker start backend",
    "rm -rf",
  ]);
});

test("the drill runs its steps in order and leaves the backends running", () => {
  expect(sequence("drill")).toEqual([
    "rclone lsf",
    "rclone copy",
    `psql ${LIVE} DROP DATABASE IF EXISTS restore_drill WITH (FORCE)`,
    `psql ${LIVE} CREATE DATABASE restore_drill`,
    `pg_restore -f ${SQL}`,
    `psql ${DRILL} -f ${SQL}`,
    // A stand-in for a newer migration's table, then the restore again,
    // into a populated database, as step 3.
    `psql ${DRILL} CREATE TABLE drill_newer (candidate_id uuid REFERENCES candidates)`,
    `pg_restore -f ${SQL}`,
    `psql ${DRILL} -f ${SQL}`,
    `psql ${DRILL} SELECT count(*) FROM candidates`,
    `psql ${LIVE} SELECT count(*) FROM candidates`,
    `psql ${LIVE} DROP DATABASE IF EXISTS restore_drill WITH (FORCE)`,
    "rm -rf",
  ]);
});

test("the restore goes into the database the backup container points at", () => {
  expect(psqlRestores("restore").map(dbTarget)).toEqual([LIVE]);
});

// pg_restore only renders the dump as SQL: reading all of it before psql
// starts is what keeps a truncated dump from being half-applied, since psql
// commits whatever arrived when its input ends early (#233).
test("pg_restore writes the dump to a file and never connects to the database", () => {
  const c = pgRestore("restore");
  expect(values(c, "-f")).toEqual([SQL]);
  expect(c.args.some((a) => a === "-d" || a.startsWith("--dbname") || /^postgresql:/.test(a))).toBe(false);
});

test("psql doesn't run when pg_restore fails", () => {
  const { calls } = runBlock(blockIn(markdown, ""), { STUB_FAIL: "pg_restore" });
  expect(calls.some((c) => c.name === "pg_restore")).toBe(true);
  expect(calls.filter((c) => c.name === "psql")).toEqual([]);
});

// #172: a failed restore must leave the data intact, so the drops and the
// restore run as one transaction that rolls back on the first error. #233:
// it drops the whole schema, since pg_restore --clean drops only the dump's
// own objects and fails on a newer table that references them.
test("the live restore replaces the public schema all or nothing", () => {
  const [c] = psqlRestores("restore");
  expect(c.args).toContain("-1");
  expect(values(c, "-v")).toContain("ON_ERROR_STOP=1");
  expect(values(c, "-c")).toEqual([
    "DROP SCHEMA public CASCADE",
    "CREATE SCHEMA public AUTHORIZATION pg_database_owner",
    "GRANT USAGE ON SCHEMA public TO PUBLIC",
  ]);
  expect(values(c, "-f")).toEqual([SQL]);
  // psql runs -c and -f in argument order: the drops come first.
  expect(c.args.lastIndexOf("-c")).toBeLessThan(c.args.indexOf("-f"));
});

describe("drill", () => {
  test("restores into the scratch database, never the live one", () => {
    expect(psqlRestores("drill").map(dbTarget)).toEqual([DRILL, DRILL]);
  });

  // The same commands as step 3, so a dump that the live restore would
  // reject fails the drill too.
  test("runs exactly the restore's commands", () => {
    const pgRestores = (name) => runs[name].calls.filter((c) => c.name === "pg_restore");
    const live = pgRestores("restore")[0].args;
    for (const c of pgRestores("drill")) expect(c.args).toEqual(live);
    const livePsql = psqlRestores("restore")[0].args.map((a) => (a === LIVE ? DRILL : a));
    for (const c of psqlRestores("drill")) expect(c.args).toEqual(livePsql);
  });
});
