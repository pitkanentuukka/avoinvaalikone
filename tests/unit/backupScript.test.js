// scripts/backup/backup.sh runs nightly in the backup sidecar. It must keep the
// local backup volume bounded whatever happens to the remote side, because the
// volume shares the Docker host's disk with PostgreSQL (issue #152):
// - an rclone upload or remote-prune failure still applies local retention,
//   and still exits non-zero so the failure is visible;
// - a pg_dump failure never leaves a partial dump that retention would treat
//   as the newest valid backup and keep in place of the last good one.
//
// The script runs with stub pg_dump and rclone commands first on PATH and
// BACKUP_DIR pointing at a temporary directory; the real database and object
// storage are never touched. Every test runs under /bin/sh and, when it is
// installed, busybox sh, the shell the backup sidecar (postgres:16-alpine)
// actually uses. Only the shell changes: ls, flock, rm etc. still come from
// the host's PATH, not busybox applets.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/backup/backup.sh");

// pg_dump stub: the output file is its last argument. STUB_PGDUMP=fail writes
// part of a dump and then fails, as pg_dump does when the connection drops.
// STUB_PGDUMP=nested starts a second backup run mid-dump (a manual run
// overlapping the cron one) and records its exit status and stderr.
const PG_DUMP_STUB = `#!/bin/sh
for arg; do out=$arg; done
printf 'PGDMP partial' > "$out"
if [ "\${STUB_PGDUMP:-}" = fail ]; then
  echo "pg_dump: error: connection lost" >&2
  exit 1
fi
if [ "\${STUB_PGDUMP:-}" = nested ]; then
  STUB_PGDUMP= "$STUB_SHELL" "$STUB_SCRIPT" 2> "$STUB_NESTED.err" || echo $? > "$STUB_NESTED.status"
  [ -e "$STUB_NESTED.status" ] || echo 0 > "$STUB_NESTED.status"
  [ -e "$out" ] || { echo "pg_dump: output file removed" >&2; exit 1; }
fi
printf ' complete' >> "$out"
`;

// pg_restore stub for the full read `pg_restore -f /dev/null FILE`, which
// succeeds only on a complete dump. Any other form fails: `pg_restore -l`
// reads just the table of contents, which a dump truncated mid-data still has.
const PG_RESTORE_STUB = `#!/bin/sh
[ "$1" = -f ] && [ "$2" = /dev/null ] && [ $# -eq 3 ] || exit 1
grep -q complete "$3"
`;

// rclone stub: logs each call; STUB_RCLONE_FAIL names a subcommand to fail.
const RCLONE_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ "$1" = "\${STUB_RCLONE_FAIL:-}" ]; then
  echo "rclone: $1 failed: remote unavailable" >&2
  exit 1
fi
`;

// Seeded "earlier runs", oldest first; seedDump gives each an mtime one hour
// apart in the past, so newest-by-mtime is deterministic.
const OLD_DUMPS = [
  "vaalikone-20260101-030000.dump",
  "vaalikone-20260102-030000.dump",
];

const SHELLS = [["/bin/sh"]];
if (spawnSync("busybox", ["sh", "-c", "true"]).status === 0) {
  SHELLS.push(["busybox sh"]);
}

let tmp, backupDir, binDir, logFile, nestedBase, seeded;

function seedDump(name, hoursAgo = 10 - seeded++, content = "PGDMP old complete") {
  const file = path.join(backupDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() - hoursAgo * 3600 * 1000);
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  backupDir = path.join(tmp, "backups");
  binDir = path.join(tmp, "bin");
  logFile = path.join(tmp, "rclone.log");
  nestedBase = path.join(tmp, "nested");
  seeded = 0;
  fs.mkdirSync(backupDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "pg_dump"), PG_DUMP_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "rclone"), RCLONE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "pg_restore"), PG_RESTORE_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "busybox-sh"), '#!/bin/sh\nexec busybox sh "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(logFile, "");
  for (const name of OLD_DUMPS) seedDump(name);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.each(SHELLS)("backup.sh under %s", (shell) => {
  const [shellCmd, ...shellArgs] = shell.split(" ");

  // An env value of undefined removes that variable.
  function runBackup(env = {}) {
    const fullEnv = {
      PATH: `${binDir}:${process.env.PATH}`,
      BACKUP_DIR: backupDir,
      DATABASE_URL: "postgresql://stub/stub",
      BACKUP_BUCKET: "bucket",
      STUB_LOG: logFile,
      STUB_SHELL: shellCmd === "busybox" ? path.join(binDir, "busybox-sh") : shellCmd,
      STUB_SCRIPT: SCRIPT,
      STUB_NESTED: nestedBase,
      ...env,
    };
    for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
    const result = spawnSync(shellCmd, [...shellArgs, SCRIPT], {
      encoding: "utf8",
      env: fullEnv,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      // The run's .backup.lock and a restore/ directory are not dumps.
      files: fs
        .readdirSync(backupDir)
        .filter((f) => !f.startsWith(".") && f !== "restore")
        .sort(),
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
    expect(run.rcloneCalls).toEqual([
      expect.stringMatching(/^copyto /),
      expect.stringMatching(/^delete /),
    ]);
    expect(run.files).toHaveLength(1);
    expect(newDumps(run.files)).toEqual(run.files);
    expect(contents(run.files[0])).toBe("PGDMP partial complete");
  });

  test("repeated upload failures do not accumulate local dumps", () => {
    let run;
    for (let i = 0; i < 3; i++) {
      // Runs in the same second reuse one stamp, so seed an extra dump before
      // each run to check that every run, not just the first, prunes.
      seedDump(`vaalikone-2026010${3 + i}-030000.dump`, 1);
      run = runBackup({ STUB_RCLONE_FAIL: "copyto" });
      expect(run.status).not.toBe(0);
    }
    expect(run.files).toHaveLength(1);
    expect(newDumps(run.files)).toEqual(run.files);
    expect(run.files[0]).not.toMatch(/^vaalikone-2026010/);
    expect(contents(run.files[0])).toBe("PGDMP partial complete");
  });

  test("a pg_dump failure keeps the last good dump and leaves no partial one", () => {
    const run = runBackup({ STUB_PGDUMP: "fail" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ERROR: pg_dump failed/);
    // The partial output is gone, so it can never be picked as the newest dump.
    expect(newDumps(run.files)).toEqual([]);
    // The newest previous dump is kept as the recovery point; older ones are
    // still pruned, so a disk already filled by old dumps recovers.
    expect(run.files).toEqual([OLD_DUMPS[1]]);
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
    // A lock file left behind by that run does not block this one.
    fs.writeFileSync(path.join(backupDir, ".backup.lock"), "");
    const run = runBackup();

    expect(run.status).toBe(0);
    expect(run.files).toHaveLength(1);
    expect(run.files[0]).toMatch(/^vaalikone-\d{8}-\d{6}\.dump$/);
    expect(contents(run.files[0])).toBe("PGDMP partial complete");
  });

  test.each([
    ["a manually named dump", "vaalikone-before-migration.dump"],
    ["a future-stamped dump", "vaalikone-29991231-235959.dump"],
  ])("%s never makes a run delete its own new dump", (_label, name) => {
    // Letters and future stamps sort after today's stamp by name.
    seedDump(name, 1);
    const run = runBackup({ STUB_RCLONE_FAIL: "copyto" });

    expect(run.status).not.toBe(0);
    expect(run.files).toHaveLength(1);
    expect(newDumps(run.files)).not.toContain(name);
    expect(run.files[0]).toMatch(/^vaalikone-\d{8}-\d{6}\.dump$/);
    expect(contents(run.files[0])).toBe("PGDMP partial complete");
  });

  test("a truncated newest dump is not kept in place of the last good one", () => {
    // The pre-#152 script wrote pg_dump output in place, so a failed run
    // (ENOSPC) could leave a truncated dump with the newest mtime.
    seedDump("vaalikone-20260103-030000.dump", 0, "PGDMP trunc");
    const run = runBackup({ STUB_PGDUMP: "fail" });

    expect(run.status).not.toBe(0);
    expect(run.files).toEqual([OLD_DUMPS[1]]);
  });

  test("if no dump is readable the newest is kept rather than none", () => {
    fs.rmSync(backupDir, { recursive: true });
    fs.mkdirSync(backupDir);
    seedDump("vaalikone-20260101-030000.dump", 2, "PGDMP trunc");
    seedDump("vaalikone-20260102-030000.dump", 1, "PGDMP trunc");
    const run = runBackup({ STUB_PGDUMP: "fail" });

    expect(run.status).not.toBe(0);
    expect(run.files).toEqual(["vaalikone-20260102-030000.dump"]);
  });

  test("a pg_dump failure on an empty volume reports it and leaves nothing", () => {
    fs.rmSync(backupDir, { recursive: true });
    fs.mkdirSync(backupDir);
    const run = runBackup({ STUB_PGDUMP: "fail" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ERROR: pg_dump failed/);
    // Reported once, not again by the EXIT trap.
    expect(run.stderr.match(/ERROR:/g)).toHaveLength(1);
    expect(run.files).toEqual([]);
  });

  test("an abort by set -e still logs an ERROR line", () => {
    const run = runBackup({ DATABASE_URL: undefined });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ERROR: backup.sh exited with status/);
  });

  test("a dump fetched into restore/ for a restore survives a run", () => {
    seedDump("restore/vaalikone-20251201-030000.dump", 100);
    const run = runBackup({ STUB_PGDUMP: "fail" });

    expect(run.status).not.toBe(0);
    expect(fs.readdirSync(path.join(backupDir, "restore"))).toEqual([
      "vaalikone-20251201-030000.dump",
    ]);
  });

  test("an overlapping run refuses to start and leaves the running one intact", () => {
    const run = runBackup({ STUB_PGDUMP: "nested" });

    expect(fs.readFileSync(`${nestedBase}.status`, "utf8").trim()).toBe("1");
    expect(fs.readFileSync(`${nestedBase}.err`, "utf8")).toMatch(/another backup/);
    expect(run.status).toBe(0);
    expect(run.files).toHaveLength(1);
    expect(contents(run.files[0])).toBe("PGDMP partial complete");
    // Only the outer run uploaded.
    expect(run.rcloneCalls.filter((c) => c.startsWith("copyto"))).toHaveLength(1);
  });
});
