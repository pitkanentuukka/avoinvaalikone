/**
 * Shared DB mock helpers for route tests.
 * Usage: jest.mock('../../src/db/pool') then import these.
 */

const db = require("../../src/db/pool");

/**
 * Reset db.query and db.getClient mocks between tests.
 */
function resetDbMocks() {
  db.query.mockReset();
  db.getClient.mockReset();
}

/**
 * Build a mock pg PoolClient and wire it to db.getClient.
 * Returns the client so callers can set up call-specific return values.
 */
function buildMockClient() {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };
  db.getClient.mockResolvedValue(client);
  return client;
}

module.exports = { resetDbMocks, buildMockClient };
