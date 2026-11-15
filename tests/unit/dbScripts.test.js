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
function fakePool({ connectError, failOn, query } = {}) {
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  process.exit.mockImplementation(() => finish());

  const client = {
    query: jest.fn(async (sql, params) => {
      if (failOn && sql.includes(failOn)) throw new Error("boom");
      if (query) return query(sql, params);
      if (sql.includes("AS has_data")) return { rows: [{ has_data: false }] };
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
  // Model the seed's rows across separate CLI invocations. Existing parties
  // return no rows from INSERT ... ON CONFLICT DO NOTHING, as PostgreSQL does.
  function seedDatabase(existing = {}) {
    const tables = { parties: [], question_sets: [], questions: [], candidates: [], ...existing };
    const query = (sql, params) => {
      if (sql.includes("AS has_data")) {
        return { rows: [{ has_data: Object.values(tables).some((rows) => rows.length) }] };
      }
      if (sql.includes("INSERT INTO parties")) {
        if (tables.parties.length) return { rows: [] };
        tables.parties = ["sd-2026-x7k9", "nc-2026-m3p1", "gl-2026-q8w2"]
          .map((token, id) => ({ id, token }));
        return { rows: tables.parties };
      }
      if (sql.includes("INSERT INTO question_sets")) {
        const rows = ["Ilmasto", "Koulutus", "Digitaaliset"].map((title, id) => ({ id, title }));
        tables.question_sets.push(...rows);
        return { rows };
      }
      if (sql.includes("INSERT INTO questions ")) {
        const rows = [{ id: tables.questions.length }];
        tables.questions.push(...rows);
        return { rows };
      }
      if (sql.includes("INSERT INTO candidates")) {
        if (params.some((id) => id == null)) throw new Error("party_id must not be null");
        const rows = ["Anna Virtanen", "Mikko Korhonen", "Liisa Mäkelä", "Jari Niemi"]
          .map((name, id) => ({ id, name }));
        tables.candidates.push(...rows);
        return { rows };
      }
      return { rows: [] };
    };
    return { tables, query };
  }

  test("seeding twice succeeds and the second run leaves all sample data untouched", async () => {
    const database = seedDatabase();
    const first = fakePool(database);
    runScript("seed.js");
    await first.done();
    expect(process.exitCode).toBeUndefined();
    expect(database.tables.questions).toHaveLength(10);
    expect(database.tables.candidates).toHaveLength(4);
    const before = JSON.parse(JSON.stringify(database.tables));

    const second = fakePool(database);
    runScript("seed.js");
    await second.done();
    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    expect(database.tables).toEqual(before);
    expect(sqls(second.client).some((sql) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    expect(sqls(second.client)).toContain("COMMIT");
    expect(second.client.release).toHaveBeenCalledTimes(1);
    expect(second.pool.end).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ohitetaan"));
  });

  test.each(["parties", "question_sets", "questions", "candidates"])(
    "existing %s alone prevents sample data from being added", async (table) => {
      const database = seedDatabase({ [table]: [{ id: "existing" }] });
      const { client, done } = fakePool(database);
      runScript("seed.js");
      await done();
      expect(process.exitCode).toBeUndefined();
      expect(sqls(client).some((sql) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
      expect(sqls(client)).toContain("COMMIT");
    }
  );

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
  // Model transaction boundaries, including those embedded in actual SQL
  // files. A history failure must never leave the migration committed alone.
  function migrationDatabase({ failHistory = false, failMigration = false } = {}) {
    const state = { committed: [], pending: null };
    const query = (sql, params) => {
      if (sql.includes("INSERT INTO migration_history")) {
        if (failHistory) throw new Error("history unavailable");
        (state.pending ?? state.committed).push(`history:${params[0]}`);
      } else if (sql.includes("SELECT filename FROM migration_history")) {
        return { rows: state.committed.filter((s) => s.startsWith("history:"))
          .map((s) => ({ filename: s.slice(8) })) };
      } else {
        for (const statement of sql.replace(/--[^\n]*/g, "").split(";")) {
          const text = statement.trim();
          if (text === "BEGIN") state.pending ??= [];
          else if (text === "COMMIT") {
            state.committed.push(...(state.pending ?? []));
            state.pending = null;
          } else if (text === "ROLLBACK") state.pending = null;
          else if (text.startsWith("CREATE EXTENSION")) {
            if (failMigration) throw new Error("migration unavailable");
            (state.pending ?? state.committed).push("schema:001");
          } else if (/CREATE INDEX CONCURRENTLY/.test(text) && state.pending) {
            throw new Error("CREATE INDEX CONCURRENTLY cannot run inside a transaction block");
          }
        }
      }
      return { rows: [] };
    };
    return { state, query };
  }

  test("each migration and its history row commit in one runner-owned transaction", async () => {
    const database = migrationDatabase();
    const { client, done } = fakePool(database);
    runScript("run.js");
    await done();
    expect(process.exitCode).toBeUndefined();
    const calls = sqls(client);
    const historyCalls = calls.flatMap((sql, index) => sql.startsWith("INSERT INTO migration_history") ? [index] : []);
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const index of historyCalls) {
      expect(calls[index - 2]).toBe("BEGIN");
      expect(calls[index - 1]).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
      expect(calls[index + 1]).toBe("COMMIT");
    }
    expect(database.state.committed).toContain("schema:001");
    expect(database.state.committed).toContain("history:001_initial.sql");
  });

  test("a failed history insert rolls back the schema and allows a clean retry", async () => {
    const database = migrationDatabase({ failHistory: true });
    const { client, done } = fakePool(database);
    runScript("run.js");
    await done();
    expect(process.exitCode).toBe(1);
    expect(database.state.committed).toEqual([]);
    expect(database.state.pending).toBeNull();
    expect(sqls(client)).toContain("ROLLBACK");
    expect(sqls(client).indexOf("ROLLBACK")).toBeLessThan(sqls(client).indexOf("SELECT pg_advisory_unlock($1)"));
  });

  test("a failed migration rolls back before unlocking and writes no history", async () => {
    const database = migrationDatabase({ failMigration: true });
    const { client, done } = fakePool(database);
    runScript("run.js");
    await done();
    expect(process.exitCode).toBe(1);
    expect(database.state.pending).toBeNull();
    expect(database.state.committed).toEqual([]);
    expect(sqls(client)).toContain("ROLLBACK");
    expect(sqls(client).some((sql) => sql.startsWith("INSERT INTO migration_history"))).toBe(false);
  });

  test("a second run skips committed migrations without opening transactions", async () => {
    const database = migrationDatabase();
    const first = fakePool(database);
    runScript("run.js");
    await first.done();
    expect(process.exitCode).toBeUndefined();
    const second = fakePool(database);
    runScript("run.js");
    await second.done();
    expect(process.exitCode).toBeUndefined();
    expect(sqls(second.client)).not.toContain("BEGIN");
    expect(sqls(second.client).some((sql) => sql.startsWith("INSERT INTO migration_history"))).toBe(false);
  });

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
