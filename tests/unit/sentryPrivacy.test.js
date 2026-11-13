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
let eventSeen;

beforeAll(() => {
  process.env.SENTRY_DSN = TEST_DSN;
  Sentry = require("../../src/instrument");
  app = require("../../src/index");
  db = require("../../src/db/pool");
  eventSeen = new Promise((resolve) => {
    Sentry.getClient().on("beforeSendEvent", (event) => {
      events.push(event);
      resolve();
    });
  });
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

  await eventSeen;
  expect(events).toHaveLength(1);
  const [event] = events;

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
