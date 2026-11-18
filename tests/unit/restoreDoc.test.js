// scripts/backup/restore.md is followed by hand during an outage, so its
// commands must work as written (issue #163). BACKUP_BUCKET and DATABASE_URL
// are set only inside the backup container (docker-compose.prod.yml); the
// operator's host shell normally has neither, so they must expand inside the
// container, not in the host shell before `docker compose exec` runs.
//
// The test runs the doc's bash block under /bin/sh with a stub `docker` that
// behaves like `docker compose exec <service> <argv…>`: it runs argv directly
// (no shell, as exec does) with the backup container's environment. rclone,
// pg_restore and rm are stubs that record their arguments; nothing real is
// touched.

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

function runDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-doc-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const name of ["rclone", "pg_restore", "rm"]) {
    fs.writeFileSync(path.join(bin, name), RECORDER, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  const log = path.join(dir, "log");
  fs.writeFileSync(log, "");

  const script = bashBlocks(fs.readFileSync(DOC, "utf8"))
    .join("\n")
    .replaceAll("<stamp>", STAMP);

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

describe("scripts/backup/restore.md", () => {
  let res, calls;
  beforeAll(() => {
    ({ res, calls } = runDoc());
  });

  test("the commands run as written", () => {
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });

  test("rclone fetches from the bucket configured in the backup container", () => {
    const rclone = calls.filter((c) => c.name === "rclone");
    expect(rclone).toHaveLength(1);
    expect(rclone[0].args).toEqual([
      "copy",
      `upcloud:${BUCKET}/postgres/vaalikone-${STAMP}.dump`,
      "/backups/restore/",
    ]);
  });

  test("pg_restore restores into the database the backup container points at", () => {
    const restore = calls.filter((c) => c.name === "pg_restore");
    expect(restore).toHaveLength(1);
    const { args } = restore[0];
    expect(args[args.indexOf("-d") + 1]).toBe(CONTAINER_DB_URL);
    expect(args).toContain(`/backups/restore/vaalikone-${STAMP}.dump`);
  });

  test("every container command goes to the backup service", () => {
    const execs = calls
      .filter((c) => c.name === "docker" && c.args.includes("exec"))
      .map((c) => c.args[c.args.indexOf("exec") + 1]);
    expect(execs.length).toBeGreaterThan(0);
    expect(new Set(execs)).toEqual(new Set(["backup"]));
  });
});
