const { fork } = require("child_process");
const path = require("path");

// Political opinions are GDPR special-category data, and the research data is
// kept unlinkable on purpose (random session id, no IP, no date). An error
// event sent to Sentry must not carry a voter's answers, weights or
// constituency: @sentry/node attaches the incoming request body to error
// events by default (issue #34).
//
// Sentry runs in a child process (tests/helpers/sentryEventsChild.js), so
// nothing it hooks outlives this file in the Jest worker; see that file.

const CHILD = path.join(__dirname, "../helpers/sentryEventsChild.js");

const QUESTION_ID = "3b9d7c1e-5f2a-4e8b-9c6d-1a2b3c4d5e6f";
const CONSTITUENCY = "Lapin vaalipiiri";
const ERROR = "something broke after the body was parsed";
// Behind the production proxies the client address arrives in headers.
const CLIENT_IP = "203.0.113.7";
const CANDIDATE_TOKEN = "3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b3c4d5e6f7a8b";

const PARTY_TOKEN = "a".repeat(48);
const REGISTRATION_TOKEN = "b".repeat(48);

let result;
let childOutput = "";

beforeAll(async () => {
  const child = fork(CHILD, [JSON.stringify({
    questionId: QUESTION_ID, constituency: CONSTITUENCY, clientIp: CLIENT_IP, error: ERROR,
    candidateToken: CANDIDATE_TOKEN, partyToken: PARTY_TOKEN, registrationToken: REGISTRATION_TOKEN,
  })], {
    execArgv: [],
    silent: true,
    env: {
      ...process.env,
      // Nothing listens on port 1: the transport fails fast instead of
      // reaching a real Sentry project, and every query fails as in a
      // database outage. Set explicitly, since src/index.js loads a
      // developer's .env and dotenv never overwrites a variable that is set.
      SENTRY_DSN: "http://public@127.0.0.1:1/1",
      DATABASE_URL: "postgres://vaalikone@127.0.0.1:1/vaalikone",
      SMTP_HOST: "",
      REDIS_URL: "",
      NODE_ENV: "test",
    },
  });
  child.stdout.on("data", (d) => { childOutput += d; });
  child.stderr.on("data", (d) => { childOutput += d; });
  // After the result message, so that the access log lines are all in.
  const closed = new Promise((resolve) => child.on("close", resolve));
  result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Sentry child process timed out:\n${childOutput}`));
    }, 15000);
    child.on("message", (msg) => { clearTimeout(timer); resolve(msg); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Sentry child process exited (${code}) without a result:\n${childOutput}`));
    });
  });
  if (result.error) throw new Error(`${result.error}\n${childOutput}`);
  await closed;
}, 20000);

test("Sentry is enabled in the child, so the checks below aren't vacuous", () => {
  expect(result.sentryEnabled).toBe(true);
  expect(result.status).toBe(500);
});

test("an error during a voter match doesn't send the voter's answers to Sentry", () => {
  const event = result.matchEvent;

  // The event is the DB failure, and still says which route it came from.
  expect(event.exception.values[0].value).toMatch(/ECONNREFUSED/);
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
test("a request body that some other path puts on an event is dropped", () => {
  const event = result.scopeEvent;

  expect(event.exception.values[0].value).toBe(ERROR);
  expect(event.request.url).toContain("/api/voter/match");
  expect(event.request.data).toBeUndefined();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(QUESTION_ID);
  expect(serialized).not.toContain(CONSTITUENCY);
});

// Exercise the real SDK pipeline, including transaction names and breadcrumbs.
test.each(["me", "party", "register"])("a failed %s token route sends no credentials to Sentry", (route) => {
  const { status, event } = result.tokenEvents.find((item) => item.route === route);

  expect(status).toBe(500);
  expect(event.exception.values[0].value).toMatch(/ECONNREFUSED/);
  expect(event.request.url).toContain(`/api/candidates/${route}/[token]`);
  // SDK versions may use the route template or the concrete request path.
  expect(event.transaction).toContain(`/api/candidates/${route}/`);
  expect(event.breadcrumbs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      category: "http",
      data: expect.objectContaining({ url: `http://localhost/api/candidates/${route}/[token]` }),
    }),
  ]));
  for (const token of [CANDIDATE_TOKEN, PARTY_TOKEN, REGISTRATION_TOKEN]) {
    expect(JSON.stringify(event)).not.toContain(token);
  }
});

test("the access log lines for failed token requests don't contain credentials", () => {
  for (const route of ["me", "party", "register"]) {
    expect(childOutput).toContain(`GET /api/candidates/${route}/[token] 500`);
  }
  for (const token of [CANDIDATE_TOKEN, PARTY_TOKEN, REGISTRATION_TOKEN]) {
    expect(childOutput).not.toContain(token);
  }
});
