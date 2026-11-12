// Transaction helpers for a client from db.getClient(). Routes use these
// instead of raw BEGIN/COMMIT/ROLLBACK so that rollback() knows whether there
// is anything to roll back: an error before BEGIN (or from BEGIN itself), or
// a second rollback after an early-return one, sends nothing.
//
// Pooled clients are reused, so the open-transaction mark is cleared whenever
// a transaction ends.
const open = new WeakSet();

async function begin(client) {
  await client.query("BEGIN");
  open.add(client);
}

// COMMIT ends the transaction even when it fails: Postgres rolls back an
// aborted or constraint-violating transaction, and a COMMIT that never
// reached the server leaves a dead connection with nothing to roll back.
async function commit(client) {
  try {
    await client.query("COMMIT");
  } finally {
    open.delete(client);
  }
}

// Roll back a failed transaction without masking the error that caused it.
// The client is undefined when getClient() itself failed. ROLLBACK rejects
// when the connection broke mid-transaction; pg marks such a client
// unqueryable and the pool discards it on release(), so there is nothing
// more to do in either case.
async function rollback(client) {
  if (!client || !open.delete(client)) return;
  try {
    await client.query("ROLLBACK");
  } catch {
    // ignore
  }
}

module.exports = { begin, commit, rollback };
