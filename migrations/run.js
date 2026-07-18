const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

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
      await client.query(sql);
      await client.query(
        "INSERT INTO migration_history (filename) VALUES ($1)",
        [file]
      );
      console.log(`✓ Migration ${file} applied successfully`);
    }
  } catch (err) {
    console.error("✗ Migration failed:", err.message);
    process.exit(1);
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
