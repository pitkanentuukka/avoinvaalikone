const { fork } = require("child_process");
const path = require("path");
const { unusedPort } = require("../helpers/fakeRedis");

// Every rate limiter the app actually mounts (src/index.js,
// src/routes/candidates.js) must fail open, and fast, with Redis down
// (issue #149). Each request below goes through one limiter and is answered
// without the database, so its status shows what the limiter did: the
// route's own 4xx when it let the request through, a 500 when the store
// error reached Express (a limiter without passOnStoreError).
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

let results;
let output = "";

beforeAll(async () => {
  const redisPort = await unusedPort();
  const child = fork(CHILD, [JSON.stringify(REQUESTS)], {
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
  expect(output).toContain("allowing request without rate-limiting");
});
