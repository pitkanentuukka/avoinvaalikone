const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find all .sql files sorted by name
    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      // Extract numeric prefix, e.g. 001_initial.sql → 1
      const version = parseInt(file, 10);
      if (isNaN(version)) continue;

      const { rows } = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (rows.length > 0) {
        console.log(`  Migration ${file} already applied, skipping`);
        continue;
      }

      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      await pool.query(sql);
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
