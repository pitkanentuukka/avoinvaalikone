// Child process for tests/unit/sentryPrivacy.test.js: starts the app with
// Sentry enabled, triggers errors, and sends the events the SDK would send
// back to the parent over IPC.
//
// It runs in its own process because Sentry.init hooks process-wide state
// (diagnostics_channel subscriptions, process handlers) that Sentry.close()
// doesn't undo. Inside a Jest worker that outlives the test file, and the
// stale client then touches the torn-down test environment's globals while
// later files in the same worker serve requests (the stack overflow in
// health.test.js on CI). Here it also runs as in production: the SDK's
// require hooks instrument express, which Jest's module loader bypasses.

const http = require("http");

const { questionId, constituency, clientIp, error, candidateToken, partyToken, registrationToken } = JSON.parse(process.argv[2]);

const Sentry = require("../../src/instrument");
const app = require("../../src/index");

let onEvent = () => {};
// Resolves with the next event the SDK sends. beforeSendEvent fires after the
// event processors and beforeSend, so this is exactly what would leave.
const nextEvent = () => new Promise((resolve) => { onEvent = resolve; });
Sentry.getClient().on("beforeSendEvent", (event) => onEvent(event));

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

function post(port, path, body, headers) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  // A voter match while the database is unreachable (DATABASE_URL points at a
  // closed port), the issue #34 scenario.
  let eventSent = nextEvent();
  const status = await post(
    server.address().port,
    "/api/voter/match",
    {
      answers: { [questionId]: 4 },
      weights: { [questionId]: 3 },
      constituency,
      includeInResearch: true,
    },
    { "X-Forwarded-For": clientIp, "X-Real-IP": clientIp }
  );
  const matchEvent = await eventSent;

  // Each credential tier must stay private when its auth lookup fails (#83).
  const tokenEvents = [];
  for (const [route, token] of [
    ["me", candidateToken],
    ["party", partyToken],
    ["register", registrationToken],
  ]) {
    Sentry.addBreadcrumb({
      category: "http",
      data: { url: `http://localhost/api/candidates/${route}/${token}` },
    });
    eventSent = nextEvent();
    const status = await get(server.address().port, `/api/candidates/${route}/${token}`);
    tokenEvents.push({ route, status, event: await eventSent });
  }
  server.close();

  // A body on the request data from another path than the http integration:
  // setupExpressErrorHandler builds it from the parsed req.body when an error
  // reaches it outside its request's async context.
  eventSent = nextEvent();
  Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        url: "http://localhost/api/voter/match",
        method: "POST",
        data: { answers: { [questionId]: 4 }, constituency },
      },
    });
    Sentry.captureException(new Error(error));
  });
  const scopeEvent = await eventSent;

  return { sentryEnabled: true, status, matchEvent, scopeEvent, tokenEvents };
}

main().then(
  (result) => process.send(result, () => process.exit(0)),
  (err) => process.send({ error: err.stack || String(err) }, () => process.exit(1))
);
