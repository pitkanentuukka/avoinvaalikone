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
    // The SDK attaches each request's body to its error events by default.
    // A match request's body is a voter's answers, weights and constituency,
    // political opinions the research data is kept unlinkable to protect, and
    // Sentry is a third party. The stack trace and the route are enough to
    // debug with (issue #34).
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
  });
}

module.exports = Sentry;
