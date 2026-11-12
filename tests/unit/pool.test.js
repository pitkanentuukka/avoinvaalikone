const { EventEmitter } = require("events");
const { pool } = require("../../src/db/pool");

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

afterAll(() => pool.end());

describe("pool", () => {
  // pg-pool drops its own error listener while a client is checked out, so a
  // connection that dies mid-transaction would emit 'error' with no listener
  // and crash the process (issue #5).
  test("a checked-out client's socket error doesn't throw", () => {
    const client = new EventEmitter();
    pool.emit("connect", client);

    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  test("an idle client's error is logged once and doesn't throw", () => {
    const client = new EventEmitter();
    pool.emit("connect", client);
    const err = new Error("Connection terminated unexpectedly");

    // What pg-pool's idle listener does after the client's own listeners run.
    client.emit("error", err);
    expect(() => pool.emit("error", err, client)).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
