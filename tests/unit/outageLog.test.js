const { createOutageLog } = require("../../src/outageLog");

// Issue #156: during a Redis outage every rate-limited request logged a full
// stack trace. An outage log reports the first failure at once, then at most
// one summary per interval with a count, and the recovery.

// A fake clock and timer queue: advance() runs the timers that fall due.
// `before` runs first, like an I/O callback the event loop gets to before a
// late timer.
function setup(intervalMs = 60_000) {
  let now = 1_000_000;
  let timers = [];
  const lines = [];
  const times = [];
  const log = createOutageLog("Store", {
    intervalMs,
    now: () => now,
    log: (line) => {
      lines.push(line);
      times.push(now);
    },
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timers = timers.filter((t) => t !== timer);
    },
  });
  const advance = (ms, before) => {
    now += ms;
    before?.();
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  const gaps = () => times.slice(1).map((t, i) => t - times[i]);
  return { log, lines, advance, gaps, pendingTimers: () => timers.length };
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
  const { log, lines, advance, gaps } = setup();
  for (let i = 0; i < 10_000; i++) {
    advance(30); // 10,000 flaps over 300 s
    log.failure("timed out");
    log.recovered();
  }
  advance(60_000); // let a held recovery come due
  expect(lines.length).toBeLessThanOrEqual(300 / 60 + 2);
  for (const gap of gaps()) expect(gap).toBeGreaterThanOrEqual(60_000);
  expect(lines[0]).toBe("Store failing: timed out");
  expect(lines.at(-1)).toMatch(/^Store (recovered|failed again and recovered)/);
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

// Review round 2: a held recovery's timer that ran late, after another line,
// logged a second line milliseconds later.
test("a late timer doesn't log within the interval of a newer line", () => {
  const { log, lines, advance } = setup();
  log.failure("a"); // 0 s: logged
  advance(1_000);
  log.recovered(); // held; its timer is due at 60 s
  advance(1_000);
  log.failure("b");
  advance(58_100, () => {
    log.failure("c"); // 60.1 s, before the late timer: summarised
    log.recovered(); // held again
  });
  expect(lines).toEqual([
    "Store failing: a",
    "Store still failing: 2 more failures in the last 60 s (latest: c)",
  ]);
  advance(59_000);
  expect(lines).toHaveLength(2);
  advance(1_000); // 60 s after the summary
  expect(lines.at(-1)).toBe("Store recovered");
});

test("reset drops a held recovery and its timer", () => {
  const { log, lines, advance, pendingTimers } = setup();
  log.failure("a");
  advance(1_000);
  log.recovered(); // held
  log.reset();
  expect(pendingTimers()).toBe(0);
  advance(120_000);
  expect(lines).toEqual(["Store failing: a"]);
});

test("a new outage soon after a recovery line is announced as failing again, with its count", () => {
  const { log, lines, advance } = setup();
  log.failure("a");
  advance(60_000);
  log.recovered(); // logged
  advance(1_000);
  log.failure("b"); // within the interval of "recovered": counted
  advance(1_000);
  log.failure("c");
  advance(58_000);
  log.failure("d");
  expect(lines).toEqual([
    "Store failing: a",
    "Store recovered",
    "Store failing again: 3 failures in the last 60 s (latest: d)",
  ]);
});

test("a short outage soon after a recovery line is counted in the next recovery", () => {
  const { log, lines, advance } = setup();
  log.failure("a");
  advance(60_000);
  log.recovered(); // logged
  advance(1_000);
  log.failure("b"); // counted, not logged
  log.recovered(); // held
  advance(59_000);
  expect(lines).toEqual([
    "Store failing: a",
    "Store recovered",
    "Store failed again and recovered: 1 failure since the last report (latest: b)",
  ]);
});

// Random interleavings, with timers firing early (Node's timers start from
// the cached loop time) and late (a busy event loop).
test.each([1, 2, 3, 4, 5, 6, 7, 8])("random interleaving %i: lines an interval apart, counts add up, recovery logged", (seed) => {
  let x = seed;
  const random = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let now = 0;
  let timers = [];
  const lines = [];
  const times = [];
  const log = createOutageLog("Store", {
    now: () => now,
    log: (line) => { lines.push(line); times.push(now); },
    schedule: (fn, ms) => {
      const skew = random() < 0.2 ? -200 * random() : random() < 0.5 ? 10_000 * random() : 0;
      const timer = { at: now + Math.max(0, ms + skew), fn };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => { timers = timers.filter((t) => t !== timer); },
  });
  const runTimers = () => {
    for (;;) {
      const due = timers.filter((t) => t.at <= now);
      if (due.length === 0) return;
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    }
  };
  let failures = 0;
  for (let i = 0; i < 3000; i++) {
    now += random() < 0.1 ? 30_000 * random() : 500 * random();
    runTimers();
    if (random() < 0.5) { log.failure(`e${i}`); failures++; } else log.recovered();
  }
  log.recovered();
  for (let i = 0; i < 10 && timers.length; i++) { now += 70_000; runTimers(); }

  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(60_000);
  expect(lines.at(-1)).toMatch(/^Store (recovered|failed again and recovered)/);
  const counted = lines.reduce((sum, line) => {
    if (/^Store failing: /.test(line)) return sum + 1;
    const n = line.match(/(\d+) (more )?failures?/);
    return sum + (n ? Number(n[1]) : 0);
  }, 0);
  expect(counted).toBe(failures);
});
