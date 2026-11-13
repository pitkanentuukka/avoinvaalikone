// Sentry must initialize before Express is required so its auto-
// instrumentation can hook http/express. Inert when SENTRY_DSN is unset
// (development, CI).
const Sentry = require("@sentry/node");
const { redactTokensDeep } = require("./redactTokens");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // Errors only — performance tracing at election-night rates would blow
    // through the free-tier quota and add overhead for no decision value.
    tracesSampleRate: 0,
    // The SDK attaches each request's body to its error events by default.
    // A match request's body is a voter's answers, weights and constituency:
    // political opinions, which the research data is kept unlinkable to
    // protect, and Sentry is a third party. The stack trace and the route are
    // enough to debug with (issue #34).
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
    // The Express error handler can still attach the parsed req.body when an
    // error reaches it outside its request's async context, and a future SDK
    // version may add other ways; drop the body from every event regardless.
    // Then mask party, registration and candidate tokens wherever a URL was
    // recorded (request URL, transaction name, breadcrumbs): they're bearer
    // secrets carried in the path (issue #36).
    beforeSend(event) {
      if (event.request) delete event.request.data;
      return redactTokensDeep(event);
    },
    // Transactions skip beforeSend. None are sent at tracesSampleRate 0, but
    // if tracing is turned on, their names and span URLs carry tokens too.
    beforeSendTransaction: (event) => redactTokensDeep(event),
  });
}

module.exports = Sentry;
