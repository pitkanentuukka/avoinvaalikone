const { fork } = require("child_process");
const path = require("path");
const { FakeRedis, unusedPort } = require("../helpers/fakeRedis");

// The Redis-backed rate-limit store must not take the backend down with
// Redis (issue #149). rate-limit-redis loads its scripts when the store is
// constructed and only awaits them on the first request, so a load that
// failed first was an unhandled rejection and Node exited. The limiters pass
// requests on store errors (passOnStoreError), so with Redis unavailable a
// request should fail open quickly and the store should work again once Redis
// is back.
//
// The store runs in a child process (tests/helpers/rateLimitStoreChild.js) so
// a crash shows up as that process exiting; the fake Redis runs here.

jest.setTimeout(30000);

const CHILD = path.join(__dirname, "../helpers/rateLimitStoreChild.js");

// The limiters sit in front of every API request. With Redis down (nothing
// listening, connection dropped) a limiter call must fail at once instead of
// waiting in node-redis's offline queue for the command timeout.
const DOWN_BOUND_MS = 1000;
// With Redis connected but not answering, an increment is an EVALSHA plus a
// script reload, each bounded by the client's command timeout.
const HUNG_BOUND_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child;
let servers = [];

afterEach(async () => {
  if (child) child.kill();
  child = undefined;
  await Promise.all(servers.map((server) => server.stop()));
  servers = [];
});

async function startRedis(mode, port = 0) {
  const server = new FakeRedis(mode);
  const actualPort = await server.listen(port);
  servers.push(server);
  return { server, port: actualPort };
}

async function stopRedis(server) {
  servers = servers.filter((s) => s !== server);
  await server.stop();
}

function startChild(port) {
  const proc = fork(CHILD, [], {
    execArgv: [],
    silent: true,
    env: { ...process.env, REDIS_URL: `redis://127.0.0.1:${port}` },
  });
  let output = "";
  proc.stdout.on("data", (d) => { output += d; });
  proc.stderr.on("data", (d) => { output += d; });

  let exit = null;
  let nextId = 0;
  const pending = new Map();
  const exitError = () => new Error(`rate-limit store process exited (${exit}):\n${output}`);

  const ready = new Promise((resolve, reject) => {
    proc.on("message", (msg) => {
      if (msg.ready) return resolve();
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    });
    proc.on("exit", (code, signal) => {
      exit = code ?? signal;
      reject(exitError());
      for (const { reject: rejectPending } of pending.values()) rejectPending(exitError());
      pending.clear();
    });
  });

  return {
    ready,
    alive: () => exit === null,
    output: () => output,
    increment: () => new Promise((resolve, reject) => {
      if (exit !== null) return reject(exitError());
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.send({ id });
    }),
    kill: () => proc.kill("SIGKILL"),
  };
}

// Increments until one succeeds: node-redis reconnects with backoff (at most
// ~2.2 s between attempts), and the store reloads its scripts after a failure.
async function eventuallyOk(store, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await store.increment();
    if (last.ok) return last;
    await sleep(100);
  }
  throw new Error(`no successful increment within ${timeoutMs} ms; last: ${JSON.stringify(last)}`);
}

async function expectStillAlive(store) {
  // Long enough for any rejected script load to surface as a crash.
  await sleep(300);
  if (!store.alive()) throw new Error(`process crashed:\n${store.output()}`);
}

test("Redis down at startup: requests fail open fast, the process survives, and the store recovers", async () => {
  const port = await unusedPort();
  child = startChild(port);
  await child.ready;

  const down = await child.increment();
  expect(down.ok).toBe(false);
  expect(down.ms).toBeLessThan(DOWN_BOUND_MS);
  await expectStillAlive(child);

  await startRedis("ok", port);
  const up = await eventuallyOk(child);
  expect(up.totalHits).toBe(1);
});

test("Redis refusing script loads (LOADING after a restart) doesn't crash, and the store recovers", async () => {
  const { server, port } = await startRedis("loading");
  child = startChild(port);
  await child.ready;

  const refused = await child.increment();
  expect(refused.ok).toBe(false);
  await expectStillAlive(child);

  server.mode = "ok";
  const up = await eventuallyOk(child);
  expect(up.totalHits).toBe(1);
});

test("Redis going away fails requests open fast, and a restarted Redis is used again", async () => {
  const first = await startRedis("ok");
  child = startChild(first.port);
  await child.ready;
  expect((await eventuallyOk(child)).totalHits).toBe(1);

  await stopRedis(first.server);
  // Let the client see the dropped connection before the next request.
  await sleep(100);
  const down = await child.increment();
  expect(down.ok).toBe(false);
  expect(down.ms).toBeLessThan(DOWN_BOUND_MS);
  await expectStillAlive(child);

  // A restarted Redis has lost the loaded scripts (NOSCRIPT) and the counters.
  await startRedis("ok", first.port);
  const up = await eventuallyOk(child);
  expect(up.totalHits).toBe(1);
});

test("a connected Redis that stops answering fails requests open within the command timeout", async () => {
  const { server, port } = await startRedis("ok");
  child = startChild(port);
  await child.ready;
  await eventuallyOk(child);

  server.mode = "hang";
  const hung = await child.increment();
  expect(hung.ok).toBe(false);
  expect(hung.ms).toBeLessThan(HUNG_BOUND_MS);
  await expectStillAlive(child);
});
