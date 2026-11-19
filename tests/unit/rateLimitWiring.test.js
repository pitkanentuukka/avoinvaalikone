const { fork } = require("child_process");
const path = require("path");
const { unusedPort } = require("../helpers/fakeRedis");

// Every rate limiter the app actually mounts (src/index.js,
// src/routes/candidates.js) must fail open, and fast, with Redis down
// (issue #149). The public-read limiters' routes need the database, which
// this test leaves unreachable, so their fail-open is tested in
// publicReadLimit.test.js instead. Each request below goes through one limiter and is answered
// without the database, so its status shows what the limiter did: the
// route's own 4xx when it let the request through, a 500 when the store
// error reached Express (a limiter that doesn't fail open).
//
// While Redis is down, the outage is logged a bounded number of times and
// without stack traces, not once per request (issue #156): at election-night
// rates that filled the log rotation within minutes and added a synchronous
// stderr write to every request.
//
// The app runs in a child process (tests/helpers/appRequestsChild.js) in
// production mode, the only mode in which the limiters run.

jest.setTimeout(20000);

const CHILD = path.join(__dirname, "../helpers/appRequestsChild.js");
// A NUL is rejected (404) before the token is looked up in the database.
const BAD_TOKEN = "%00";

const REQUESTS = [
  // adminLimiter, then requireAdmin
  { limiter: "admin", method: "GET", path: "/api/admin/parties", expected: 401 },
  // tokenLimiter("rl:party:"), ("rl:register:"), ("rl:me:"), then the
  // token check
  { limiter: "party", method: "GET", path: `/api/candidates/party/${BAD_TOKEN}`, expected: 404 },
  { limiter: "register", method: "GET", path: `/api/candidates/register/${BAD_TOKEN}`, expected: 404 },
  { limiter: "me", method: "GET", path: `/api/candidates/me/${BAD_TOKEN}`, expected: 404 },
  // submissionLimiter, then the submission's validation
  { limiter: "submission", method: "POST", path: "/api/question-sets", body: {}, expected: 400 },
  // matchLimiter, then the match request's validation
  { limiter: "match", method: "POST", path: "/api/voter/match", body: {}, expected: 400 },
];
// A burst on the match endpoint, as on election night.
const BURST = 50;
const SENT = [
  ...REQUESTS,
  ...Array.from({ length: BURST }, () => REQUESTS.find((r) => r.limiter === "match")),
];

let results;
let output = "";

beforeAll(async () => {
  const redisPort = await unusedPort();
  const child = fork(CHILD, [JSON.stringify(SENT)], {
    execArgv: [],
    silent: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      // Nothing listens on port 1: no route below may need the database.
      DATABASE_URL: "postgresql://vaalikone@127.0.0.1:1/vaalikone",
      ADMIN_SECRET: "test-admin-secret",
    },
  });
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const message = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`app exited (${code}) before answering:\n${output}`)));
  });
  if (message.error) throw new Error(`${message.error}\n${output}`);
  results = message.results;
});

test.each(REQUESTS.map((r) => [r.limiter, r]))(
  "the %s limiter lets requests through at once while Redis is down",
  (limiter, { method, path: requestPath, expected }) => {
    const result = results.find((r) => r.method === method && r.path === requestPath);
    expect(result.status).toBe(expected);
    expect(result.ms).toBeLessThan(1000);
  }
);

test("the store errors were what the limiters passed over", () => {
  // Without this, a limiter that skipped the store entirely would also pass.
  expect(output).toMatch(/Rate-limit store failing: .*letting requests through without rate limiting/);
});

test("the burst got through too", () => {
  expect(results).toHaveLength(SENT.length);
  for (const r of results.slice(REQUESTS.length)) expect(r.status).toBe(400);
});

test("the outage is logged once, without stack traces, not per request", () => {
  expect(output).not.toMatch(/^\s+at /m);
  const storeLines = output.split("\n").filter((l) => /rate.?limit/i.test(l));
  expect(storeLines).toHaveLength(1);
});
