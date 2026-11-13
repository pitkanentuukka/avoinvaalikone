// migrations/seed.js and migrations/run.js are CLI scripts that run on
// require. On failure they must still release their client and end the pool,
// then exit non-zero (the Dockerfile's `node migrations/run.js && ...` relies
// on the exit code). process.exit() would end the process before the
// `finally` cleanup runs, so they set process.exitCode instead (issue #56).
//
// process.exit is stubbed here so the test process survives, which means
// `finally` runs in this test either way; the assertions that it is never
// called and that exitCode is 1 are what tell the two behaviours apart.

jest.mock("pg", () => ({ Pool: jest.fn() }));

// Required here, outside jest.isolateModules, so the scripts' isolated
// registry gets this same mocked module and Pool.mockImplementation reaches it.
const { Pool } = require("pg");

let savedExitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  jest.spyOn(process, "exit").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = savedExitCode;
  jest.restoreAllMocks();
  Pool.mockReset();
});

// Wires up a fake pool. `connect` is the pool.connect() result; `failOn` is a
// substring of the SQL whose query rejects. Returns the fakes plus a promise
// that settles once the script has ended the pool or called process.exit,
// with a timeout so a script that does neither fails the test instead of
// hanging it.
function fakePool({ connectError, failOn } = {}) {
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  process.exit.mockImplementation(() => finish());

  const client = {
    query: jest.fn(async (sql) => {
      if (failOn && sql.includes(failOn)) throw new Error("boom");
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => {
      if (connectError) throw connectError;
      return client;
    }),
    end: jest.fn(async () => finish()),
  };
  Pool.mockImplementation(() => pool);

  const done = () => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("script neither ended the pool nor exited")), 1000);
    });
    return Promise.race([finished, timeout])
      .finally(() => clearTimeout(timer))
      .then(() => new Promise((resolve) => setImmediate(resolve)));
  };

  return { client, pool, done };
}

function runScript(file) {
  jest.isolateModules(() => require(`../../migrations/${file}`));
}

const sqls = (client) => client.query.mock.calls.map(([sql]) => sql.trim());

describe("migrations/seed.js", () => {
  test("a failed query rolls back, releases the client and ends the pool", async () => {
    const { client, pool, done } = fakePool({ failOn: "INSERT INTO parties" });
    runScript("seed.js");
    await done();

    expect(sqls(client)).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("✗ Seed failed:", "boom");
  });

  test("a failed connect ends the pool and exits non-zero", async () => {
    const { pool, done } = fakePool({ connectError: new Error("ECONNREFUSED") });
    runScript("seed.js");
    await done();

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("✗ Seed failed:", "ECONNREFUSED");
  });
});

describe("migrations/run.js", () => {
  // Guards the exit code the Dockerfile's `run.js && exec node src/index.js`
  // depends on: success must not leave exitCode set, or the server never starts.
  test("a successful run ends the pool and leaves the exit code at 0", async () => {
    const { client, pool, done } = fakePool();
    runScript("run.js");
    await done();

    expect(sqls(client)).toContain("SELECT pg_advisory_unlock($1)");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a failed migration unlocks, releases the client and ends the pool", async () => {
    const { client, pool, done } = fakePool({ failOn: "CREATE TABLE IF NOT EXISTS schema_migrations" });
    runScript("run.js");
    await done();

    expect(sqls(client)).toContain("SELECT pg_advisory_unlock($1)");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("✗ Migration failed:", "boom");
  });

  test("a failed connect ends the pool and exits non-zero", async () => {
    const { pool, done } = fakePool({ connectError: new Error("ECONNREFUSED") });
    runScript("run.js");
    await done();

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("✗ Migration failed:", "ECONNREFUSED");
  });
});
