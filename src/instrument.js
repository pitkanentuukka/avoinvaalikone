// Sentry must initialize before Express is required so its auto-
// instrumentation can hook http/express. Inert when SENTRY_DSN is unset
// (development, CI).
const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // Errors only — performance tracing at election-night rates would blow
    // through the free-tier quota and add overhead for no decision value.
    tracesSampleRate: 0,
  });
}

module.exports = Sentry;
