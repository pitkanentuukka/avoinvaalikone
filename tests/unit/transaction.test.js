const { begin, commit, rollback } = require("../../src/db/transaction");

const mockClient = () => ({ query: jest.fn().mockResolvedValue({}) });
const sqls = (client) => client.query.mock.calls.map(([sql]) => sql);

describe("begin", () => {
  test("issues BEGIN on the client", async () => {
    const client = mockClient();
    await begin(client);
    expect(sqls(client)).toEqual(["BEGIN"]);
  });

  test("propagates a failed BEGIN", async () => {
    const client = mockClient();
    client.query.mockRejectedValue(new Error("Connection terminated"));
    await expect(begin(client)).rejects.toThrow("Connection terminated");
  });
});

describe("commit", () => {
  test("issues COMMIT on the client", async () => {
    const client = mockClient();
    await begin(client);
    await commit(client);
    expect(sqls(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  test("propagates a failed COMMIT", async () => {
    const client = mockClient();
    await begin(client);
    client.query.mockRejectedValue(new Error("Connection terminated"));
    await expect(commit(client)).rejects.toThrow("Connection terminated");
  });
});

describe("rollback", () => {
  test("issues ROLLBACK after BEGIN", async () => {
    const client = mockClient();
    await begin(client);
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  test("swallows a failed ROLLBACK on a dead connection", async () => {
    const client = mockClient();
    await begin(client);
    client.query.mockRejectedValue(new Error("Connection terminated"));
    await expect(rollback(client)).resolves.toBeUndefined();
  });

  test("does nothing when getClient() never returned a client", async () => {
    await expect(rollback(undefined)).resolves.toBeUndefined();
  });

  // Issue #18: an error before BEGIN (e.g. a pre-transaction SELECT) must not
  // send a stray ROLLBACK, which Postgres answers with a warning.
  test("does nothing when BEGIN was never issued", async () => {
    const client = mockClient();
    await rollback(client);
    expect(client.query).not.toHaveBeenCalled();
  });

  test("does nothing when BEGIN itself failed", async () => {
    const client = mockClient();
    client.query.mockRejectedValueOnce(new Error("Connection terminated"));
    await expect(begin(client)).rejects.toThrow();
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN"]);
  });

  test("does nothing after COMMIT", async () => {
    const client = mockClient();
    await begin(client);
    await commit(client);
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  // COMMIT ends the transaction even when it fails (Postgres rolls back),
  // and a COMMIT that never reached the server leaves a dead connection.
  test("does nothing after a failed COMMIT", async () => {
    const client = mockClient();
    await begin(client);
    client.query.mockRejectedValueOnce(new Error("deferred constraint violated"));
    await expect(commit(client)).rejects.toThrow();
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  // An early-return ROLLBACK followed by the catch block's must not send two.
  test("rolls back only once", async () => {
    const client = mockClient();
    await begin(client);
    await rollback(client);
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  // Pooled clients are reused: a finished transaction mustn't leak into the
  // next request's state.
  test("tracks each transaction on a reused client separately", async () => {
    const client = mockClient();
    await begin(client);
    await rollback(client);
    await rollback(client); // next request fails before its BEGIN
    await begin(client);
    await rollback(client);
    expect(sqls(client)).toEqual(["BEGIN", "ROLLBACK", "BEGIN", "ROLLBACK"]);
  });
});
