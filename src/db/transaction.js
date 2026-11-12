// Roll back a failed transaction without masking the error that caused it.
// The client is undefined when getClient() itself failed. ROLLBACK rejects
// when the connection broke mid-transaction; pg marks such a client
// unqueryable and the pool discards it on release(), so there is nothing
// more to do in either case.
async function rollback(client) {
  try {
    await client?.query("ROLLBACK");
  } catch {
    // ignore
  }
}

module.exports = { rollback };
