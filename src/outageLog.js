// Logs a failing dependency a bounded number of times, however many requests
// hit it (issue #156). During a Redis outage every rate-limited request fails
// over to no limiting; logging each one, with a stack trace, filled the
// 3 × 10 MB log rotation within minutes at election-night rates (pushing out
// the lines about the outage itself) and added a synchronous stderr write to
// every request on a server already at peak load.
//
// At most one line per interval, whatever the pattern of failures:
// - the first failure of an outage is logged at once (if the last line is an
//   interval old, as it is after any quiet spell);
// - later failures are counted and summarised once the interval has passed;
// - the recovery is logged when the caller sees a success, or, if that comes
//   within the interval of the last line, once the interval has passed and
//   the dependency is still up.
// So a flapping dependency (success, failure, success, … as with event-loop
// lag near the store's deadline, or a Redis that accepts a connection and
// drops it) can't log a line per flap. Messages only, never stacks: the
// failure is a known one.
const DEFAULT_INTERVAL_MS = 60_000;

function createOutageLog(
  name,
  {
    intervalMs = DEFAULT_INTERVAL_MS,
    // Monotonic: a wall-clock step back would stall the summaries.
    now = () => performance.now(),
    // Looked up per line, not captured here, so anything that replaces
    // console.error later (a test spy) sees the lines.
    log = (line) => console.error(line),
    // unref'd: a held recovery line must not keep the process alive.
    schedule = (fn, ms) => setTimeout(fn, ms).unref(),
  } = {}
) {
  let failing = false;
  let heldRecovery = false; // recovered, but not logged yet
  let timerArmed = false;
  let unreported = 0; // failures since the last line
  let lastLine = -Infinity;

  const plural = (n) => `${n} more failure${n === 1 ? "" : "s"}`;
  const due = (t) => t - lastLine >= intervalMs;
  const emit = (t, line) => {
    log(line);
    lastLine = t;
    unreported = 0;
  };
  const recoveredLine = () =>
    `${name} recovered${unreported ? ` (${plural(unreported)} since the last report)` : ""}`;

  function flushRecovery() {
    timerArmed = false;
    if (failing || !heldRecovery) return; // failing again: the summary covers it
    heldRecovery = false;
    emit(now(), recoveredLine());
  }

  return {
    failure(message) {
      const t = now();
      if (!failing && !heldRecovery) {
        failing = true;
        if (due(t)) emit(t, `${name} failing: ${message}`);
        else unreported++; // right after the last line: summarised later
        return;
      }
      // Still failing, or failing again before a held recovery was logged:
      // one outage either way.
      failing = true;
      heldRecovery = false;
      unreported++;
      if (due(t)) {
        const seconds = Math.round((t - lastLine) / 1000);
        emit(t, `${name} still failing: ${plural(unreported)} in the last ${seconds} s (latest: ${message})`);
      }
    },

    // Cheap when nothing failed: callers run it on every success.
    recovered() {
      if (!failing) return;
      failing = false;
      const t = now();
      if (due(t)) {
        heldRecovery = false;
        emit(t, recoveredLine());
        return;
      }
      heldRecovery = true;
      if (!timerArmed) {
        timerArmed = true;
        schedule(flushRecovery, lastLine + intervalMs - t);
      }
    },

    isFailing: () => failing,

    // Back to a fresh state; for tests that share a module-level log.
    reset() {
      failing = false;
      heldRecovery = false;
      unreported = 0;
      lastLine = -Infinity;
    },
  };
}

module.exports = { createOutageLog };
