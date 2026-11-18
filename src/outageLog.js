// Logs a failing dependency a bounded number of times, however many requests
// hit it (issue #156). During a Redis outage every rate-limited request
// fails over to no limiting; logging each one, with a stack trace, filled the
// 3 × 10 MB log rotation within minutes at election-night rates (pushing out
// the lines about the outage itself) and added a synchronous stderr write to
// every request on a server already at peak load.
//
// The first failure is logged at once, later ones are counted and summarised
// at most once per interval, and the recovery is logged when the caller sees
// a success. Messages only, never stacks: the failure is a known one.
const DEFAULT_INTERVAL_MS = 60_000;

// console.error is looked up per line, not captured here, so anything that
// replaces it later (Sentry's console integration, a test spy) sees the lines.
function createOutageLog(
  name,
  { intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, log = (line) => console.error(line) } = {}
) {
  let failing = false;
  let unreported = 0; // failures since the last line
  let lastLine = 0;
  let latest = "";

  const plural = (n) => `${n} more failure${n === 1 ? "" : "s"}`;

  return {
    failure(message) {
      const t = now();
      if (!failing) {
        failing = true;
        unreported = 0;
        lastLine = t;
        log(`${name} failing: ${message}`);
        return;
      }
      unreported++;
      latest = message;
      if (t - lastLine >= intervalMs) {
        log(`${name} still failing: ${plural(unreported)} in the last ${Math.round((t - lastLine) / 1000)} s (latest: ${latest})`);
        unreported = 0;
        lastLine = t;
      }
    },

    // Cheap when nothing failed: callers run it on every success.
    recovered() {
      if (!failing) return;
      failing = false;
      log(`${name} recovered${unreported ? ` (${plural(unreported)} since the last report)` : ""}`);
      unreported = 0;
    },
  };
}

module.exports = { createOutageLog };
