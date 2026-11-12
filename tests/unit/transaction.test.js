const { rollback } = require("../../src/db/transaction");

describe("rollback", () => {
  test("issues ROLLBACK on the client", async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };
    await rollback(client);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  test("swallows a failed ROLLBACK on a dead connection", async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error("Connection terminated")) };
    await expect(rollback(client)).resolves.toBeUndefined();
  });

  test("does nothing when getClient() never returned a client", async () => {
    await expect(rollback(undefined)).resolves.toBeUndefined();
  });
});
