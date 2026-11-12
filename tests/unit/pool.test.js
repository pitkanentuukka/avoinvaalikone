const { EventEmitter } = require("events");
const { pool } = require("../../src/db/pool");

afterAll(() => pool.end());

describe("pool", () => {
  // pg-pool drops its own error listener while a client is checked out, so a
  // connection that dies mid-transaction would emit 'error' with no listener
  // and crash the process (issue #5).
  test("a checked-out client's socket error doesn't throw", () => {
    const client = new EventEmitter();
    pool.emit("connect", client);
    jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    console.error.mockRestore();
  });
});
