// Manual mock for src/db/pool.js — used automatically when jest.mock() is called
const query = jest.fn();
const getClient = jest.fn();

module.exports = { query, getClient };
