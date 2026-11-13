const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../src/db/pool");
jest.mock("../../src/email");
// Keeps the rate limiters off Redis, so a failing REDIS_URL test can close the
// client without rejecting the stores' queued script loads. src/index.js still
// requires src/redis.js itself, which is what the test checks.
jest.mock("../../src/middleware/rateLimitStore", () => () => undefined);

// Point src/index.js's own dotenv.config() call (with whatever options it
// passes, e.g. a future override: true) at a .env like a developer's, which
// sets SMTP_HOST, SENTRY_DSN and REDIS_URL. The values point nowhere real, so
// a failing test can't reach a real service either.
const mockEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaalikone-env-"));
const mockEnvFile = path.join(mockEnvDir, ".env");
fs.writeFileSync(
  mockEnvFile,
  [
    "SMTP_HOST=smtp.example.fi",
    "SENTRY_DSN=https://public@sentry.example.invalid/1",
    "REDIS_URL=redis://127.0.0.1:1",
    "",
  ].join("\n")
);

jest.mock("dotenv", () => {
  const actual = jest.requireActual("dotenv");
  return { ...actual, config: (options = {}) => actual.config({ ...options, path: mockEnvFile }) };
});

let Sentry;
let redis;

beforeAll(() => {
  require("../../src/index");
  Sentry = require("../../src/instrument");
  redis = require("../../src/redis");
});

afterAll(async () => {
  fs.rmSync(mockEnvDir, { recursive: true, force: true });
  // Only reached when the test below fails: don't leave the client retrying.
  if (redis) redis.destroy();
  if (Sentry.getClient()) await Sentry.close(0);
});

// A developer .env that sets SMTP_HOST would make every test file that forgets
// jest.mock("../../src/email") send real mail, and the email_log insert that
// follows each send lands on the mocked db.query later, stealing results
// another test queued (issue #9).
test("a .env that sets SMTP_HOST doesn't enable email in tests", () => {
  expect(process.env.SMTP_HOST).toBe("");
});

// With SENTRY_DSN set, the route tests that trigger 500s on purpose
// (dbFailures.test.js) would report fake errors to the real Sentry project
// (issue #40).
test("a .env that sets SENTRY_DSN doesn't start Sentry in tests", () => {
  expect(process.env.SENTRY_DSN).toBe("");
  expect(Sentry.getClient()).toBeUndefined();
});

// With REDIS_URL set, every route test would connect to a real Redis and keep
// rate-limit counters there, shared between parallel Jest workers (issue #40).
test("a .env that sets REDIS_URL doesn't connect to Redis in tests", () => {
  expect(process.env.REDIS_URL).toBe("");
  expect(redis).toBeNull();
});
