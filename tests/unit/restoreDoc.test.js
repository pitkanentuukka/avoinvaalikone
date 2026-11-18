// scripts/backup/restore.md is followed by hand during an outage, so its
// commands must work as written (issue #163). BACKUP_BUCKET and DATABASE_URL
// are set only inside the backup container (docker-compose.prod.yml); the
// operator's host shell normally has neither, or a stale copy, so they must
// expand inside the container, not in the host shell before
// `docker compose exec` runs.
//
// The test runs the doc's bash blocks under /bin/sh with a stub `docker` that
// behaves like `docker compose exec <service> <argv…>`: it runs argv directly
// (no shell, as exec does) with the backup container's environment. rclone,
// pg_restore, psql and rm are stubs that record their arguments, and whether
// they ran inside the "container"; nothing real is touched.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DOC = path.join(__dirname, "../../scripts/backup/restore.md");
const STAMP = "20261101-030000"; // backup.sh: date -u +%Y%m%d-%H%M%S
const DUMP = `/backups/restore/vaalikone-${STAMP}.dump`;
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
const RECORDER = `#!/bin/sh
{ echo "== $(basename "$0") \${STUB_IN_CONTAINER:-host}"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
`;

// docker compose [-f …]… exec <service> <argv…>: run argv with the
// container's environment in place of the host's.
const DOCKER_STUB = `#!/bin/sh
{ echo "== docker host"; for a; do printf '%s\\n' "$a"; done; } >> "$STUB_LOG"
while [ $# -gt 0 ] && [ "$1" != exec ]; do shift; done
[ $# -eq 0 ] && exit 0
shift 2
exec env STUB_IN_CONTAINER=container BACKUP_BUCKET="$STUB_BUCKET" DATABASE_URL="$STUB_DB_URL" "$@"
`;

function runBlock(block) {
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

function dbTarget(call) {
  const i = call.args.indexOf("-d");
  return i >= 0 ? call.args[i + 1] : call.args[0];
}

const markdown = fs.readFileSync(DOC, "utf8");
const runs = {
  restore: runBlock(blockIn(markdown, "")),
  drill: runBlock(blockIn(markdown, "Restore drill")),
};
const pgRestore = (name) => runs[name].calls.find((c) => c.name === "pg_restore");

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
    expect(of("pg_restore")).toHaveLength(1);
    expect(pgRestore(name).args.at(-1)).toBe(DUMP);
  });

  test("the fetched dump is removed at the end", () => {
    expect(of("rm").map((c) => c.args)).toEqual([["-rf", "/backups/restore"]]);
    expect(calls.at(-1).name).toBe("rm");
  });
});

test("the restore goes into the database the backup container points at", () => {
  expect(dbTarget(pgRestore("restore"))).toBe(LIVE);
});

describe("drill", () => {
  test("restores into the scratch database, never the live one", () => {
    expect(dbTarget(pgRestore("drill"))).toBe(DRILL);
  });

  test("uses the restore's pg_restore flags, and stops on the first error", () => {
    const flags = (c) => c.args.filter((a) => a.startsWith("--"));
    expect(flags(pgRestore("drill"))).toEqual([
      ...flags(pgRestore("restore")),
      "--exit-on-error",
    ]);
  });

  test("is re-runnable and cleans up its scratch database", () => {
    const sql = runs.drill.calls
      .filter((c) => c.name === "psql")
      .map((c) => [dbTarget(c), c.args[c.args.indexOf("-c") + 1]]);
    expect(sql).toEqual([
      [LIVE, "DROP DATABASE IF EXISTS restore_drill"],
      [LIVE, "CREATE DATABASE restore_drill"],
      [DRILL, "SELECT count(*) FROM candidates"],
      [LIVE, "SELECT count(*) FROM candidates"],
      [LIVE, "DROP DATABASE restore_drill"],
    ]);
  });
});
