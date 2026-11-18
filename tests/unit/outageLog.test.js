const { createOutageLog } = require("../../src/outageLog");

// Issue #156: during a Redis outage every rate-limited request logged a full
// stack trace. An outage log reports the first failure at once, then at most
// one summary per interval with a count, and the recovery.

function setup(intervalMs = 60_000) {
  let now = 1_000_000;
  const lines = [];
  const log = createOutageLog("Store", {
    intervalMs,
    now: () => now,
    log: (line) => lines.push(line),
  });
  return { log, lines, advance: (ms) => { now += ms; } };
}

test("the first failure is logged at once, with its message", () => {
  const { log, lines } = setup();
  log.failure("connection refused");
  expect(lines).toEqual(["Store failing: connection refused"]);
});

test("later failures within the interval are counted, not logged", () => {
  const { log, lines, advance } = setup();
  log.failure("connection refused");
  for (let i = 0; i < 1000; i++) {
    advance(10);
    log.failure("connection refused");
  }
  expect(lines).toHaveLength(1);
});

test("at most one summary per interval, with the count and latest message", () => {
  const { log, lines, advance } = setup();
  log.failure("connection refused");
  for (let i = 0; i < 5; i++) {
    advance(1_000);
    log.failure("connection refused");
  }
  advance(55_000);
  log.failure("timed out"); // 60 s after the first line
  expect(lines).toEqual([
    "Store failing: connection refused",
    "Store still failing: 6 more failures in the last 60 s (latest: timed out)",
  ]);
  advance(1_000);
  log.failure("timed out");
  expect(lines).toHaveLength(2);
});

test("recovery is logged once, with failures not yet reported", () => {
  const { log, lines, advance } = setup();
  log.failure("connection refused");
  advance(1_000);
  log.failure("connection refused");
  log.recovered();
  log.recovered();
  expect(lines).toEqual([
    "Store failing: connection refused",
    "Store recovered (1 more failure since the last report)",
  ]);
});

test("recovery without an outage logs nothing", () => {
  const { log, lines } = setup();
  log.recovered();
  expect(lines).toEqual([]);
});

test("a new outage after recovery is logged at once", () => {
  const { log, lines, advance } = setup();
  log.failure("a");
  log.recovered();
  advance(1_000);
  log.failure("b");
  expect(lines).toEqual(["Store failing: a", "Store recovered", "Store failing: b"]);
});
