// Throwaway PostgreSQL schemas for tests that need a real database
// (TEST_DATABASE_URL): each gets the real migrations and is dropped afterwards,
// so existing application data is untouched.
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { Pool } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");
const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

// A fresh schema with its own pool. pgcrypto is database-wide; installing it
// in public first keeps 001's CREATE EXTENSION from putting it in (and
// dropping it with) the test schema.
async function createSchema(prefix) {
  const schema = `${prefix}_${randomBytes(8).toString("hex")}`;
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public -c statement_timeout=5000`,
    max: 6,
  });
  // IF NOT EXISTS still races with another Jest worker doing the same.
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public").catch((err) => {
    if (err.code !== "23505" && err.code !== "42710") throw err;
  });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query("CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz DEFAULT now())");
  return { schema, pool };
}

async function dropSchema({ schema, pool }) {
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
}

// One transaction per file, like migrations/run.js.
async function applyMigrations(pool, files) {
  const client = await pool.connect();
  try {
    for (const file of files) {
      await client.query("BEGIN");
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file}: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { MIGRATIONS_DIR, migrationFiles, createSchema, dropSchema, applyMigrations };
