const { createOutageLog } = require("../../src/outageLog");

// Issue #156: during a Redis outage every rate-limited request logged a full
// stack trace. An outage log reports the first failure at once, then at most
// one summary per interval with a count, and the recovery.

// A fake clock and timer queue: advance() runs the timers that fall due.
function setup(intervalMs = 60_000) {
  let now = 1_000_000;
  let timers = [];
  const lines = [];
  const log = createOutageLog("Store", {
    intervalMs,
    now: () => now,
    log: (line) => lines.push(line),
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
  });
  const advance = (ms) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  return { log, lines, advance, pendingTimers: () => timers.length };
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
  advance(61_000);
  log.failure("connection refused"); // summarised: 1 more
  advance(1_000);
  log.failure("connection refused");
  advance(60_000);
  log.recovered();
  log.recovered();
  expect(lines).toEqual([
    "Store failing: connection refused",
    "Store still failing: 1 more failure in the last 61 s (latest: connection refused)",
    "Store recovered (1 more failure since the last report)",
  ]);
});

test("a recovery soon after the last line is held, then logged once it's due", () => {
  const { log, lines, advance, pendingTimers } = setup();
  log.failure("connection refused");
  advance(5_000);
  log.recovered();
  expect(lines).toHaveLength(1);
  advance(54_000);
  expect(lines).toHaveLength(1);
  advance(1_000); // 60 s after the failing line
  expect(lines).toEqual(["Store failing: connection refused", "Store recovered"]);
  expect(pendingTimers()).toBe(0);
});

// Issue #156 review: a flapping Redis (success, failure, success, …) cleared
// and set the outage on every call, two lines per flap.
test("a flapping dependency logs at most one line per interval", () => {
  const { log, lines, advance } = setup();
  for (let i = 0; i < 10_000; i++) {
    advance(30); // 10,000 flaps over 300 s
    log.failure("timed out");
    log.recovered();
  }
  advance(60_000); // let a held recovery come due
  expect(lines.length).toBeLessThanOrEqual(300 / 60 + 2);
  expect(lines[0]).toBe("Store failing: timed out");
  expect(lines.at(-1)).toMatch(/^Store recovered/);
});

test("a held failure is summarised once due, and a held recovery then dropped", () => {
  const { log, lines, advance } = setup();
  log.failure("a");
  advance(1_000);
  log.recovered(); // held
  advance(1_000);
  log.failure("b"); // failing again before the held recovery was logged
  advance(58_000); // the held recovery's timer: still failing, nothing to say
  expect(lines).toEqual(["Store failing: a"]);
  advance(1_000);
  log.failure("c");
  expect(lines).toEqual([
    "Store failing: a",
    "Store still failing: 2 more failures in the last 61 s (latest: c)",
  ]);
});

test("isFailing reflects the last call, whatever was logged", () => {
  const { log } = setup();
  expect(log.isFailing()).toBe(false);
  log.failure("a");
  expect(log.isFailing()).toBe(true);
  log.recovered();
  expect(log.isFailing()).toBe(false);
});

test("recovery without an outage logs nothing", () => {
  const { log, lines } = setup();
  log.recovered();
  expect(lines).toEqual([]);
});

test("a new outage long after recovery is logged at once", () => {
  const { log, lines, advance } = setup();
  log.failure("a");
  advance(60_000);
  log.recovered();
  advance(3_600_000);
  log.failure("b");
  expect(lines).toEqual(["Store failing: a", "Store recovered", "Store failing: b"]);
});
