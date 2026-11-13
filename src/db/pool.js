const { Pool, Client } = require("pg");

// Per-process pool size. With N backend replicas the database sees up to
// N × PG_POOL_MAX connections; keep the product well under Postgres
// max_connections (default 100). Prod runs 3 replicas × 10 = 30.
const max = parseInt(process.env.PG_POOL_MAX || "10", 10);

// Server-side kill switch for runaway queries: one bad plan must not pin
// pool slots across every replica. Generous vs the ~800ms p95 target.
// Migrations use their own Pool (migrations/run.js) and are unaffected.
const statementTimeout = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "10000", 10);

// Client-side backstop for when the server can't answer at all, e.g. a
// half-open connection after a network partition: statement_timeout is
// enforced by the server, so without this a query (and the ROLLBACK after
// it) waits until the kernel gives up retransmitting, ~15 minutes. The
// default sits above statement_timeout so a merely slow query still gets
// the server's own error first. PG_STATEMENT_TIMEOUT_MS=0 switches the
// statement timeout off, and then the default leaves this one off too.
const defaultQueryTimeout = statementTimeout > 0 ? statementTimeout + 5000 : 0;
const queryTimeout = parseInt(process.env.PG_QUERY_TIMEOUT_MS || String(defaultQueryTimeout), 10);

// A typo here is silent otherwise: "abc" parses to NaN, which pg reads as
// "off", and "15s" to 15 ms, which closes healthy connections mid-query.
if (Number.isNaN(statementTimeout) || Number.isNaN(queryTimeout)) {
  console.warn("PG_STATEMENT_TIMEOUT_MS / PG_QUERY_TIMEOUT_MS is not a number; that timeout is off");
} else if (queryTimeout > 0 && statementTimeout > 0 && queryTimeout <= statementTimeout) {
  console.warn(
    `PG_QUERY_TIMEOUT_MS (${queryTimeout}) should be above PG_STATEMENT_TIMEOUT_MS (${statementTimeout}); ` +
      "slow queries will close their connection instead of getting the server's timeout error"
  );
}

const QUERY_TIMEOUT_MESSAGE = "Query read timeout";

// pg rejects a timed-out query but keeps it as the connection's active
// query, so everything sent afterwards (the ROLLBACK, the next request's
// queries once the client is back in the pool) would queue behind a reply
// that never comes. A timeout means the connection is presumed dead: close
// it, so later queries fail at once and release() discards the client.
//
// Covers query(text[, values][, callback]) and query(config[, callback]), the
// forms this codebase uses; a submittable whose callback lives on the object
// is not watched. pg starts the timer when query() is called, not when the
// query is sent, so queries pipelined on one client could time out while
// queued behind a slow one; routes run one query at a time per client.
class TimeoutClosingClient extends Client {
  query(...args) {
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const callback = args[last];
      args[last] = (err, res) => {
        this._closeIfTimedOut(err);
        callback(err, res);
      };
    }
    const result = super.query(...args);
    if (result && typeof result.catch === "function") {
      // Return the chained promise, rethrowing, so a rejection nobody
      // handles still surfaces as unhandledRejection.
      return result.catch((err) => {
        this._closeIfTimedOut(err);
        throw err;
      });
    }
    return result;
  }

  _closeIfTimedOut(err) {
    if (err?.message !== QUERY_TIMEOUT_MESSAGE || this._closedOnTimeout) return;
    this._closedOnTimeout = true;
    console.error(`Database query timed out after ${queryTimeout}ms; closing the connection`);
    this.end().catch(() => {});
  }
}

const pool = new Pool({
  Client: TimeoutClosingClient,
  connectionString: process.env.DATABASE_URL,
  max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: statementTimeout,
  query_timeout: queryTimeout,
  // TCP keepalive notices a peer that vanished while the connection had
  // nothing unacknowledged in flight: an idle pooled client, or one whose
  // query was delivered and is waiting for the reply. Node sets only the
  // idle delay; probe interval and count come from libuv or the kernel
  // (75 s × 9 by default on Linux), so this may well be slower than
  // query_timeout, which is what actually bounds a hung query.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// pg-pool only listens for client errors while a client is idle. A connection
// that dies while checked out (DB restart, failover) would emit 'error' with
// no listener, which throws and crashes the process. pg has already rejected
// the pending query by then, and the pool discards the client on release().
// This listener stays attached for the client's lifetime, so it logs idle
// failures too.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("Database connection error:", err);
  });
});

// pg-pool emits this only for an idle client's error, which the listener
// above has already logged; a handler must still exist or the emit throws.
pool.on("error", () => {});

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
