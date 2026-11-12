// Roll back a failed transaction without masking the error that caused it.
// The client is undefined when getClient() itself failed, and ROLLBACK
// rejects when the connection is dead — pg's pool discards such a client on
// release(), so there is nothing more to do in either case.
async function rollback(client) {
  try {
    await client?.query("ROLLBACK");
  } catch {
    // ignore
  }
}

module.exports = { rollback };
