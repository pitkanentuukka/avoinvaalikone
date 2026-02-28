const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Read and run migration file
    const sql = fs.readFileSync(
      path.join(__dirname, "001_initial.sql"),
      "utf8"
    );
    await pool.query(sql);
    console.log("✓ Migration 001_initial applied successfully");
  } catch (err) {
    console.error("✗ Migration failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
