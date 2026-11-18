const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");
const { begin, commit, rollback } = require("../src/db/transaction");

// Arbitrary application-wide lock id for migrations. Every backend replica
// runs migrations on startup; the advisory lock serializes them so late
// replicas block until the first one finishes, then see everything applied.
const MIGRATION_LOCK_ID = 727274;

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;

  try {
    // Advisory locks are session-scoped, so all lock-protected work must run
    // on this dedicated client, not on the pool.
    client = await pool.connect();
    // Migrations report what they changed in data (e.g. merged duplicates)
    // with RAISE NOTICE in a DO block; pg drops notices unless they are
    // listened for. Only those, which carry a PL/pgSQL context (`where`): the
    // "already exists, skipping" notices of IF [NOT] EXISTS DDL are noise.
    client.on("notice", (msg) => {
      if (msg.where) console.log(`  NOTICE: ${msg.message}`);
    });
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query("SELECT filename FROM migration_history");
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  Migration ${file} already applied, skipping`);
        continue;
      }

      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      // The runner owns the transaction: SQL files must not commit before
      // their history row is durable. Keep both on this locked session.
      await begin(client);
      await client.query(sql);
      await client.query(
        "INSERT INTO migration_history (filename) VALUES ($1)",
        [file]
      );
      await commit(client);
      console.log(`✓ Migration ${file} applied successfully`);
    }
  } catch (err) {
    await rollback(client);
    console.error("✗ Migration failed:", err.message);
    // Not process.exit(1): that would end the process before `finally`
    // unlocks, releases the client and closes the pool. The non-zero exit
    // code still stops the Dockerfile's `run.js && exec node src/index.js`.
    process.exitCode = 1;
  } finally {
    if (client) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
        .catch(() => {});
      client.release();
    }
    await pool.end();
  }
}

migrate();
