// Manual mock for src/db/pool.js — used automatically when jest.mock() is called
const query = jest.fn();
const getClient = jest.fn();
// Static counters for the admin view of /api/health.
const pool = { totalCount: 0, idleCount: 0, waitingCount: 0 };

module.exports = { query, getClient, pool };
