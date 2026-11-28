// Step 3 of scripts/backup/restore.md against a real PostgreSQL (#233). The
// command is taken from the runbook as written and run with the host's
// pg_restore and psql, which must match the server's major version.
// tests/unit/restoreDoc.test.js covers how the runbook's commands are wired
// to the backup container; this covers what the restore does to a database.
// Run with TEST_DATABASE_URL=postgres://... npm test -- --runInBand restoreRunbook
// (the role needs CREATEDB and CREATEROLE; the postgres image's user has both).
const { spawnSync } = require("child_process");
const { randomBytes } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "../..");
const STAMP = "20261101-030000";
const DUMP_NAME = `vaalikone-${STAMP}.dump`;

const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// The only `sh -c '…'` command in the restore block that runs pg_restore.
function restoreCommand() {
  const markdown = fs.readFileSync(path.join(ROOT, "scripts/backup/restore.md"), "utf8");
  const block = markdown.split(/^## /m)[0].match(/```bash\n([\s\S]*?)```/)[1];
  const commands = [...block.matchAll(/sh -c '([^']*)'/g)]
    .map((m) => m[1])
    .filter((c) => c.includes("pg_restore"));
  if (commands.length !== 1) throw new Error(`expected one pg_restore command, found ${commands.length}`);
  return commands[0];
}

describeWithDb("restore.md step 3 on a real database (#233)", () => {
  const admin = () => new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  let adminPool;
  const cleanup = [];

  function urlFor(database) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async function createDatabase() {
    const name = `restore_test_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE ${name}`);
    cleanup.push(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    return { name, url: urlFor(name) };
  }

  async function query(url, sql, params) {
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      return (await pool.query(sql, params)).rows;
    } finally {
      await pool.end();
    }
  }

  function migrate(url) {
    const res = spawnSync(process.execPath, [path.join(ROOT, "migrations/run.js")], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`migrations failed:\n${res.stdout}\n${res.stderr}`);
  }

  function run(command, args) {
    const res = spawnSync(command, args, { encoding: "utf8" });
    if (res.error) throw new Error(`${command}: ${res.error.message} (the PostgreSQL client tools must be on PATH)`);
    if (res.status !== 0) throw new Error(`${command} failed:\n${res.stderr}`);
    return res;
  }

  // A migrated database with one party and candidate, dumped as backup.sh
  // does (pg_dump -Fc) into its own directory, standing in for /backups/restore/.
  async function dumpedDatabase(beforeDump = async () => {}) {
    const db = await createDatabase();
    migrate(db.url);
    await query(db.url, "INSERT INTO parties (name, token) VALUES ('Puolue', $1)", [randomBytes(24).toString("hex")]);
    await query(db.url, "INSERT INTO candidates (party_id, name, email) SELECT id, 'Ehdokas Ennen', 'ennen@example.fi' FROM parties");
    await beforeDump(db);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-runbook-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    run("pg_dump", ["-Fc", "-f", path.join(dir, DUMP_NAME), db.url]);
    return { ...db, dir };
  }

  // What a later deploy adds after the dump: a migration whose table
  // references candidates (as 013_email_log.sql did), and new data.
  async function addNewerMigration(url) {
    await query(url, "CREATE TABLE newer_ref (id serial PRIMARY KEY, candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE)");
    await query(url, "INSERT INTO newer_ref (candidate_id) SELECT id FROM candidates");
    await query(url, "INSERT INTO migration_history (filename) VALUES ('016_newer_ref.sql')");
    await query(url, "INSERT INTO candidates (party_id, name) SELECT id, 'Ehdokas Jälkeen' FROM parties");
  }

  // Step 3's command, as the backup container would run it.
  function restore(dir, url) {
    const script = restoreCommand().replaceAll("/backups/restore/", `${dir}/`).replaceAll("<stamp>", STAMP);
    return spawnSync("sh", ["-c", script], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
  }

  const candidateNames = async (url) =>
    (await query(url, "SELECT name FROM candidates ORDER BY name")).map((r) => r.name);
  const tableExists = async (url, table) =>
    (await query(url, "SELECT to_regclass($1) AS t", [`public.${table}`]))[0].t !== null;

  beforeAll(() => {
    adminPool = admin();
    run("pg_restore", ["--version"]);
    run("psql", ["--version"]);
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) {
      if (typeof step === "function") step();
      else await adminPool.query(step);
    }
    await adminPool.end();
  });

  test("restores a dump older than a migration whose table references the dumped ones", async () => {
    const db = await dumpedDatabase();
    await addNewerMigration(db.url);

    const res = restore(db.dir, db.url);
    expect(res.stderr).not.toMatch(/ERROR|error:/);
    expect(res.status).toBe(0);

    expect(await candidateNames(db.url)).toEqual(["Ehdokas Ennen"]);
    // The newer migration's table is gone and its history row with it, so
    // the backends' migration run on start (step 4) recreates it.
    expect(await tableExists(db.url, "newer_ref")).toBe(false);
    const history = (await query(db.url, "SELECT filename FROM migration_history")).map((r) => r.filename);
    expect(history).not.toContain("016_newer_ref.sql");
    expect(history.length).toBeGreaterThan(0);
    migrate(db.url);
  });

  test("restores into an empty database, as the drill's first pass does", async () => {
    const source = await dumpedDatabase();
    const empty = await createDatabase();

    const res = restore(source.dir, empty.url);
    expect(res.status).toBe(0);
    expect(await candidateNames(empty.url)).toEqual(["Ehdokas Ennen"]);
  });

  // pg_restore reads the whole dump before psql starts: a truncated dump
  // piped straight into psql ends its input early, and psql commits
  // whatever had arrived.
  test("a truncated dump leaves the database as it was", async () => {
    const db = await dumpedDatabase();
    await addNewerMigration(db.url);
    const dump = path.join(db.dir, DUMP_NAME);
    const bytes = fs.readFileSync(dump);
    fs.writeFileSync(dump, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const res = restore(db.dir, db.url);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/pg_restore: error:/);
    expect(await candidateNames(db.url)).toEqual(["Ehdokas Ennen", "Ehdokas Jälkeen"]);
    expect(await query(db.url, "SELECT count(*)::int AS n FROM newer_ref")).toEqual([{ n: 1 }]);
  });

  // A failure after the drops and part of the restore have run: the dump
  // gives a table to a role that has since been dropped.
  test("a restore that fails partway leaves the database as it was", async () => {
    const role = `restore_test_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE ROLE ${role}`);
    cleanup.push(`DROP ROLE IF EXISTS ${role}`);
    const db = await dumpedDatabase(async ({ url }) => {
      // Named to sort last, so the tables before it are created first.
      await query(url, `CREATE TABLE zz_owned (id int); ALTER TABLE zz_owned OWNER TO ${role}`);
    });
    await query(db.url, "DROP TABLE zz_owned");
    await adminPool.query(`DROP ROLE ${role}`);
    await addNewerMigration(db.url);

    const res = restore(db.dir, db.url);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(new RegExp(`role "${role}" does not exist`));
    expect(await candidateNames(db.url)).toEqual(["Ehdokas Ennen", "Ehdokas Jälkeen"]);
    expect(await query(db.url, "SELECT count(*)::int AS n FROM newer_ref")).toEqual([{ n: 1 }]);
  });
});
