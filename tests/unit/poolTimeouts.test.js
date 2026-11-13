// Issue #26: a half-open connection (the server is gone but no RST arrived)
// must not hang queries until the kernel gives up retransmitting.
//
// The fake server below completes the Postgres startup handshake and then
// never answers anything, which is what the client sees on such a connection.
const net = require("net");

const QUERY_TIMEOUT_MS = 200;

let server;
const sockets = new Set();
let db;

function startSilentServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let greeted = false;
      socket.on("data", () => {
        if (greeted) return; // swallow every query
        greeted = true;
        // AuthenticationOk ('R', len 8, code 0) + ReadyForQuery ('Z', len 5, 'I')
        socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function loadPool(env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  let mod;
  jest.isolateModules(() => {
    mod = require("../../src/db/pool");
  });
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  return mod;
}

beforeAll(async () => {
  server = await startSilentServer();
  db = loadPool({
    DATABASE_URL: `postgres://vaalikone@127.0.0.1:${server.address().port}/vaalikone`,
    PG_QUERY_TIMEOUT_MS: String(QUERY_TIMEOUT_MS),
  });
});

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  console.error.mockRestore();
  console.warn.mockRestore();
  // A timed-out connection must be closed, not left for the next request.
  // Server-side cleanup in `finally` keeps a failure from hanging the rest.
  try {
    await waitFor(() => sockets.size === 0);
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

describe("pool on a connection that never answers", () => {
  // pg-pool's pool.query releases the client with the error, so this path is
  // discarded even without the close-on-timeout client; it pins query_timeout
  // and the error message the client matches on.
  test("a query rejects after the client-side query timeout", async () => {
    const start = Date.now();
    await expect(db.query("SELECT 1")).rejects.toThrow("Query read timeout");
    expect(Date.now() - start).toBeLessThan(QUERY_TIMEOUT_MS + 1000);
  });

  // pg rejects a timed-out query but leaves it as the connection's active
  // query, so anything sent afterwards (the ROLLBACK, the next request's
  // queries) would queue behind it. The client must be dropped instead.
  test("a transaction client whose query timed out fails fast and is not reused", async () => {
    const client = await db.getClient();
    await expect(client.query("SELECT 1")).rejects.toThrow("Query read timeout");

    const start = Date.now();
    await expect(client.query("ROLLBACK")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(QUERY_TIMEOUT_MS / 2);

    client.release();
    expect(db.pool.totalCount).toBe(0);
  });
});

describe("pool config", () => {
  test("enables TCP keepalive so a silently dead connection is detected", () => {
    expect(db.pool.options.keepAlive).toBe(true);
    expect(db.pool.options.keepAliveInitialDelayMillis).toBeGreaterThan(0);
  });

  test("the default query timeout leaves the server's statement_timeout room to fire first", async () => {
    const defaults = loadPool({ PG_QUERY_TIMEOUT_MS: undefined, PG_STATEMENT_TIMEOUT_MS: undefined });
    try {
      const { query_timeout, statement_timeout } = defaults.pool.options;
      expect(statement_timeout).toBeGreaterThan(0);
      expect(query_timeout).toBeGreaterThan(statement_timeout);
    } finally {
      await defaults.pool.end();
    }
  });

  // docker-compose.yml forwards unset variables as empty strings.
  test("empty variables from Compose fall back to the defaults", async () => {
    const empty = loadPool({ PG_QUERY_TIMEOUT_MS: "", PG_STATEMENT_TIMEOUT_MS: "" });
    try {
      expect(empty.pool.options.statement_timeout).toBe(10000);
      expect(empty.pool.options.query_timeout).toBe(15000);
    } finally {
      await empty.pool.end();
    }
  });

  test("a query timeout not above the statement timeout is warned about", async () => {
    const low = loadPool({ PG_QUERY_TIMEOUT_MS: "15s", PG_STATEMENT_TIMEOUT_MS: undefined });
    try {
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("PG_QUERY_TIMEOUT_MS (15)"));
    } finally {
      await low.pool.end();
    }
  });

  // 0 switches statement_timeout off; the client-side default must not turn
  // that into a short timeout that kills long queries.
  test("the default query timeout is off when statement_timeout is off", async () => {
    const off = loadPool({ PG_QUERY_TIMEOUT_MS: undefined, PG_STATEMENT_TIMEOUT_MS: "0" });
    try {
      expect(off.pool.options.query_timeout).toBe(0);
    } finally {
      await off.pool.end();
    }
  });

  test("the default query timeout follows a raised statement_timeout", async () => {
    const raised = loadPool({ PG_QUERY_TIMEOUT_MS: undefined, PG_STATEMENT_TIMEOUT_MS: "60000" });
    try {
      expect(raised.pool.options.query_timeout).toBeGreaterThan(60000);
    } finally {
      await raised.pool.end();
    }
  });
});
