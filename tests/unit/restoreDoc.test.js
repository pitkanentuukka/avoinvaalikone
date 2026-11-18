// scripts/backup/restore.md is followed by hand during an outage, so its
// commands must work as written (issue #163). BACKUP_BUCKET and DATABASE_URL
// are set only inside the backup container (docker-compose.prod.yml); the
// operator's host shell normally has neither, so they must expand inside the
// container, not in the host shell before `docker compose exec` runs.
//
// The test runs each of the doc's bash blocks under /bin/sh with a stub
// `docker` that behaves like `docker compose exec <service> <argv…>`: it runs
// argv directly (no shell, as exec does) with the backup container's
// environment. rclone,
// pg_restore, psql and rm are stubs that record their arguments; nothing real
// is touched.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DOC = path.join(__dirname, "../../scripts/backup/restore.md");
const STAMP = "20261101T030000Z";
const BUCKET = "container-bucket";
const CONTAINER_DB_URL = "postgresql://vaalikone:pw@db:5432/vaalikone";

function bashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// Records argv one per line, then a separator, into $STUB_LOG.
const RECORDER = `#!/bin/sh
{ echo "== $(basename "$0")"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
`;

// docker compose [-f …]… exec <service> <argv…>: run argv with the
// container's environment and without the host's copies of its variables.
const DOCKER_STUB = `#!/bin/sh
{ echo "== docker"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
while [ $# -gt 0 ] && [ "$1" != exec ]; do shift; done
[ $# -eq 0 ] && exit 0
shift 2
exec env BACKUP_BUCKET="$STUB_BUCKET" DATABASE_URL="$STUB_DB_URL" "$@"
`;

function runBlock(block) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-doc-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const name of ["rclone", "pg_restore", "psql", "rm"]) {
    fs.writeFileSync(path.join(bin, name), RECORDER, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  const log = path.join(dir, "log");
  fs.writeFileSync(log, "");

  const script = block.replaceAll("<stamp>", STAMP);

  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    STUB_LOG: log,
    STUB_BUCKET: BUCKET,
    STUB_DB_URL: CONTAINER_DB_URL,
  };
  const res = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
  const calls = fs
    .readFileSync(log, "utf8")
    .split(/^== /m)
    .filter(Boolean)
    .map((chunk) => {
      const [name, ...args] = chunk.replace(/\n$/, "").split("\n");
      return { name, args };
    });
  fs.rmSync(dir, { recursive: true, force: true });
  return { res, calls };
}

const blocks = bashBlocks(fs.readFileSync(DOC, "utf8"));
const LIVE = CONTAINER_DB_URL;
const DRILL = CONTAINER_DB_URL.replace(/\/[^/]*$/, "/restore_drill");

function dbTarget(call) {
  const i = call.args.indexOf("-d");
  return i >= 0 ? call.args[i + 1] : call.args[0];
}

test("the doc has the restore and the drill blocks", () => {
  expect(blocks).toHaveLength(2);
});

describe.each([
  ["restore", 0],
  ["drill", 1],
])("%s block", (_name, index) => {
  let res, calls;
  beforeAll(() => {
    ({ res, calls } = runBlock(blocks[index]));
  });

  test("runs as written", () => {
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });

  test("rclone reads the bucket configured in the backup container", () => {
    const rclone = calls.filter((c) => c.name === "rclone");
    expect(rclone.length).toBeGreaterThan(0);
    for (const c of rclone) {
      expect(c.args[1]).toMatch(new RegExp(`^upcloud:${BUCKET}/postgres/`));
    }
    const copy = rclone.filter((c) => c.args[0] === "copy");
    expect(copy).toHaveLength(1);
    expect(copy[0].args).toEqual([
      "copy",
      `upcloud:${BUCKET}/postgres/vaalikone-${STAMP}.dump`,
      "/backups/restore/",
    ]);
  });

  test("every container command goes to the backup service", () => {
    const execs = calls
      .filter((c) => c.name === "docker" && c.args.includes("exec"))
      .map((c) => c.args[c.args.indexOf("exec") + 1]);
    expect(execs.length).toBeGreaterThan(0);
    expect(new Set(execs)).toEqual(new Set(["backup"]));
  });

  test("pg_restore reads the fetched dump", () => {
    const restore = calls.filter((c) => c.name === "pg_restore");
    expect(restore).toHaveLength(1);
    expect(restore[0].args).toContain(`/backups/restore/vaalikone-${STAMP}.dump`);
  });
});

test("the restore goes into the database the backup container points at", () => {
  const { calls } = runBlock(blocks[0]);
  const restore = calls.filter((c) => c.name === "pg_restore");
  expect(dbTarget(restore[0])).toBe(LIVE);
});

test("the drill restores into the scratch database, never the live one", () => {
  const { calls } = runBlock(blocks[1]);
  const restore = calls.filter((c) => c.name === "pg_restore");
  expect(dbTarget(restore[0])).toBe(DRILL);
  expect(restore[0].args).not.toContain("--clean");

  const psql = calls.filter((c) => c.name === "psql");
  const sql = psql.map((c) => [dbTarget(c), c.args[c.args.indexOf("-c") + 1]]);
  expect(sql).toEqual([
    [LIVE, "CREATE DATABASE restore_drill"],
    [DRILL, "SELECT count(*) FROM candidates"],
    [LIVE, "SELECT count(*) FROM candidates"],
    [LIVE, "DROP DATABASE restore_drill"],
  ]);
});
