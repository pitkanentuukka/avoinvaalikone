const { Pool } = require("pg");

// Per-process pool size. With N backend replicas the database sees up to
// N × PG_POOL_MAX connections; keep the product well under Postgres
// max_connections (default 100). Prod runs 3 replicas × 10 = 30.
const max = parseInt(process.env.PG_POOL_MAX || "10", 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Server-side kill switch for runaway queries: one bad plan must not pin
  // pool slots across every replica. Generous vs the ~800ms p95 target.
  // Migrations use their own Client (migrations/run.js) and are unaffected.
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "10000", 10),
});

pool.on("error", (err) => {
  console.error("Unexpected database pool error:", err);
});

// pg-pool only listens for client errors while a client is idle. A connection
// that dies while checked out (DB restart, failover) would emit 'error' with
// no listener and crash the process; with this listener the pending query
// rejects instead, and the pool discards the client on release().
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Database connection error:", err);
  });
});

// Warn when the pool is saturated (requests queueing for a connection) —
// the early signal that PG_POOL_MAX or the replica count needs raising.
const saturationLogger = setInterval(() => {
  if (pool.waitingCount > 0) {
    console.warn(
      `DB pool saturated: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
    );
  }
}, 30000);
saturationLogger.unref();

const SLOW_QUERY_MS = 500;

// Convenience helper: run a single query
const query = async (text, params) => {
  const start = Date.now();
  const result = await pool.query(text, params);
  const elapsed = Date.now() - start;
  if (elapsed > SLOW_QUERY_MS) {
    console.warn(`Slow query (${elapsed}ms): ${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  return result;
};

// Get a client for transactions
const getClient = () => pool.connect();

module.exports = { pool, query, getClient };
