jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");

// Political opinions are GDPR special-category data, and the research data is
// kept unlinkable on purpose (random session id, no IP, no date). An error
// event sent to Sentry must not carry a voter's answers, weights or
// constituency: @sentry/node attaches the incoming request body to error
// events by default (issue #34).

// Nothing listens on port 1, so the SDK's transport fails fast instead of
// reaching a real Sentry project.
const TEST_DSN = "http://public@127.0.0.1:1/1";

const QUESTION_ID = "3b9d7c1e-5f2a-4e8b-9c6d-1a2b3c4d5e6f";
const CONSTITUENCY = "Lapin vaalipiiri";
const DB_ERROR = "connection terminated unexpectedly";
// Behind the production proxies the client address arrives in headers.
const CLIENT_IP = "203.0.113.7";

let app;
let db;
let Sentry;
const events = [];
let onEvent = () => {};
// Resolves with the next event the SDK sends. beforeSendEvent fires after the
// event processors and beforeSend, so this is exactly what would leave.
const nextEvent = () => new Promise((resolve) => { onEvent = resolve; });

// Sentry.init subscribes to the process-wide http.server.request.start
// diagnostics channel and Sentry.close() doesn't unsubscribe, so later test
// files in the same Jest worker still have their servers wrapped by this
// closed client. That only records request sessions nobody sends; it doesn't
// change any response or send anything.
beforeAll(() => {
  process.env.SENTRY_DSN = TEST_DSN;
  // Jest's module loader bypasses the SDK's require hooks, so
  // setupExpressErrorHandler warns that express isn't instrumented. Body
  // capture and the error handler don't depend on those hooks.
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  Sentry = require("../../src/instrument");
  app = require("../../src/index");
  warn.mockRestore();
  db = require("../../src/db/pool");
  Sentry.getClient().on("beforeSendEvent", (event) => {
    events.push(event);
    onEvent(event);
  });
});

afterEach(() => {
  events.length = 0;
});

afterAll(async () => {
  process.env.SENTRY_DSN = "";
  if (Sentry?.getClient()) await Sentry.close(0);
});

test("Sentry is enabled in this test, so the check below isn't vacuous", () => {
  expect(Sentry.getClient()).toBeDefined();
});

test("an error during a voter match doesn't send the voter's answers to Sentry", async () => {
  db.query.mockRejectedValue(new Error(DB_ERROR));
  jest.spyOn(console, "error").mockImplementation(() => {});

  const eventSent = nextEvent();
  const res = await request(app)
    .post("/api/voter/match")
    .set("X-Forwarded-For", CLIENT_IP)
    .set("X-Real-IP", CLIENT_IP)
    .send({
      answers: { [QUESTION_ID]: 4 },
      weights: { [QUESTION_ID]: 3 },
      constituency: CONSTITUENCY,
      includeInResearch: true,
    });
  expect(res.status).toBe(500);

  const event = await eventSent;
  expect(events).toHaveLength(1);

  // The event is the DB failure, and still says which route it came from.
  expect(event.exception.values[0].value).toBe(DB_ERROR);
  expect(event.request.url).toContain("/api/voter/match");

  expect(event.request.data).toBeUndefined();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(QUESTION_ID);
  expect(serialized).not.toContain(CONSTITUENCY);
  // Nor anything that could link the event to the voter (sendDefaultPii is
  // off, so the SDK drops IP headers and the address).
  expect(serialized).not.toContain(CLIENT_IP);
  expect(event.user?.ip_address).toBeUndefined();
});

// setupExpressErrorHandler builds the request data from the parsed req.body
// when an error reaches it outside its request's async context, which
// maxIncomingRequestBodySize doesn't cover. Whatever puts a body on an event,
// it must not leave.
test("a request body that some other path puts on an event is dropped", async () => {
  const eventSent = nextEvent();
  Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        url: "http://localhost/api/voter/match",
        method: "POST",
        data: { answers: { [QUESTION_ID]: 4 }, constituency: CONSTITUENCY },
      },
    });
    Sentry.captureException(new Error(DB_ERROR));
  });

  const event = await eventSent;
  expect(event.request.url).toContain("/api/voter/match");
  expect(event.request.data).toBeUndefined();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(QUESTION_ID);
  expect(serialized).not.toContain(CONSTITUENCY);
});
