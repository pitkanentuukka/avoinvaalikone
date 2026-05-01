const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await pool.query("SELECT filename FROM migration_history");
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  Migration ${file} already applied, skipping`);
        continue;
      }

      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      await pool.query(sql);
      await pool.query(
        "INSERT INTO migration_history (filename) VALUES ($1)",
        [file]
      );
      console.log(`✓ Migration ${file} applied successfully`);
    }
  } catch (err) {
    console.error("✗ Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
