// scripts/backup/backup.sh runs nightly in the backup sidecar. It must keep the
// local backup volume bounded whatever happens to the remote side, because the
// volume shares the Docker host's disk with PostgreSQL (issue #152):
// - an rclone upload or remote-prune failure still applies local retention,
//   and still exits non-zero so the failure is visible;
// - a pg_dump failure never leaves a partial dump that retention would treat
//   as the newest valid backup and keep in place of the last good one.
//
// The script runs under /bin/sh with stub pg_dump and rclone commands first on
// PATH and BACKUP_DIR pointing at a temporary directory; the real database and
// object storage are never touched.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/backup/backup.sh");

// pg_dump stub: the output file is its last argument. STUB_PGDUMP=fail writes
// part of a dump and then fails, as pg_dump does when the connection drops.
const PG_DUMP_STUB = `#!/bin/sh
for arg; do out=$arg; done
printf 'PGDMP partial' > "$out"
if [ "\${STUB_PGDUMP:-}" = fail ]; then
  echo "pg_dump: error: connection lost" >&2
  exit 1
fi
printf ' complete' >> "$out"
`;

// rclone stub: logs each call; STUB_RCLONE_FAIL names a subcommand to fail.
const RCLONE_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ "$1" = "\${STUB_RCLONE_FAIL:-}" ]; then
  echo "rclone: $1 failed: remote unavailable" >&2
  exit 1
fi
`;

const OLD_DUMPS = [
  "vaalikone-20260101-030000.dump",
  "vaalikone-20260102-030000.dump",
];

let tmp, backupDir, binDir, logFile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  backupDir = path.join(tmp, "backups");
  binDir = path.join(tmp, "bin");
  logFile = path.join(tmp, "rclone.log");
  fs.mkdirSync(backupDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "pg_dump"), PG_DUMP_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "rclone"), RCLONE_STUB, { mode: 0o755 });
  fs.writeFileSync(logFile, "");
  for (const name of OLD_DUMPS) {
    fs.writeFileSync(path.join(backupDir, name), "PGDMP old complete");
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runBackup(env = {}) {
  const result = spawnSync("/bin/sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      BACKUP_DIR: backupDir,
      DATABASE_URL: "postgresql://stub/stub",
      BACKUP_BUCKET: "bucket",
      STUB_LOG: logFile,
      ...env,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    files: fs.readdirSync(backupDir).sort(),
    rcloneCalls: fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean),
  };
}

// The one dump the run itself wrote, i.e. any file not seeded beforehand.
function newDumps(files) {
  return files.filter((f) => !OLD_DUMPS.includes(f));
}

function contents(name) {
  return fs.readFileSync(path.join(backupDir, name), "utf8");
}

test("a successful run uploads, prunes remotely and keeps only the new dump", () => {
  const run = runBackup();

  expect(run.status).toBe(0);
  expect(run.files).toHaveLength(1);
  expect(run.files[0]).toMatch(/^vaalikone-\d{8}-\d{6}\.dump$/);
  expect(contents(run.files[0])).toBe("PGDMP partial complete");
  expect(run.rcloneCalls).toEqual([
    expect.stringMatching(/^copyto .*vaalikone-\d{8}-\d{6}\.dump upcloud:bucket\/postgres\//),
    "delete --min-age 30d upcloud:bucket/postgres/",
  ]);
});

test("without a bucket the dump is kept locally and old ones are pruned", () => {
  const run = runBackup({ BACKUP_BUCKET: "" });

  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/BACKUP_BUCKET not set/);
  expect(run.files).toHaveLength(1);
  expect(newDumps(run.files)).toEqual(run.files);
  expect(run.rcloneCalls).toEqual([]);
});

test("an upload failure still prunes local dumps and exits non-zero", () => {
  const run = runBackup({ STUB_RCLONE_FAIL: "copyto" });

  expect(run.status).not.toBe(0);
  expect(run.stderr).toMatch(/upload/i);
  // Only the new, complete dump survives: it is the newest recovery point.
  expect(run.files).toHaveLength(1);
  expect(newDumps(run.files)).toEqual(run.files);
  expect(contents(run.files[0])).toBe("PGDMP partial complete");
  // Remote pruning is skipped: with uploads failing, age-based deletion
  // would eventually empty the bucket.
  expect(run.rcloneCalls).toHaveLength(1);
  expect(run.rcloneCalls[0]).toMatch(/^copyto /);
});

test("a remote prune failure still prunes local dumps and exits non-zero", () => {
  const run = runBackup({ STUB_RCLONE_FAIL: "delete" });

  expect(run.status).not.toBe(0);
  expect(run.stderr).toMatch(/prun/i);
  expect(run.files).toHaveLength(1);
  expect(newDumps(run.files)).toEqual(run.files);
  expect(contents(run.files[0])).toBe("PGDMP partial complete");
});

test("repeated upload failures do not accumulate local dumps", () => {
  for (let i = 0; i < 3; i++) {
    // Distinct stamps without waiting: seed an extra "previous run" dump each time.
    fs.writeFileSync(
      path.join(backupDir, `vaalikone-2026010${3 + i}-030000.dump`),
      "PGDMP old complete"
    );
    expect(runBackup({ STUB_RCLONE_FAIL: "copyto" }).status).not.toBe(0);
  }
  expect(fs.readdirSync(backupDir)).toHaveLength(1);
});

test("a pg_dump failure keeps the last good dump and leaves no partial one", () => {
  const run = runBackup({ STUB_PGDUMP: "fail" });

  expect(run.status).not.toBe(0);
  // The partial output is gone, so it can never be picked as the newest dump.
  expect(newDumps(run.files)).toEqual([]);
  // The newest previous dump is still there as the recovery point.
  expect(run.files).toContain(OLD_DUMPS[1]);
  // Nothing is uploaded or pruned remotely.
  expect(run.rcloneCalls).toEqual([]);
});

test("a run after a failed pg_dump keeps the new complete dump", () => {
  expect(runBackup({ STUB_PGDUMP: "fail" }).status).not.toBe(0);
  const run = runBackup();

  expect(run.status).toBe(0);
  expect(run.files).toHaveLength(1);
  expect(contents(run.files[0])).toBe("PGDMP partial complete");
});

test("a partial dump left by a killed run is removed and never kept as a backup", () => {
  // A SIGKILLed run (container stop timeout, OOM) cannot clean up after itself.
  fs.writeFileSync(
    path.join(backupDir, "vaalikone-20260103-030000.dump.partial"),
    "PGDMP partial"
  );
  const run = runBackup();

  expect(run.status).toBe(0);
  expect(run.files).toHaveLength(1);
  expect(run.files[0]).toMatch(/^vaalikone-\d{8}-\d{6}\.dump$/);
  expect(contents(run.files[0])).toBe("PGDMP partial complete");
});
