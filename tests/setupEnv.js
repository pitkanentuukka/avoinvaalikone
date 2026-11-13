// Runs before every test file (jest.setupFiles in package.json).
//
// src/index.js loads .env with dotenv, so a developer .env reaches the tests.
// dotenv never overwrites a variable that is already set, so an empty value
// keeps each of these off; a test that needs one sets it itself.
//
// SMTP_HOST: a test file that forgets jest.mock("../../src/email") would send
// real mail, and each send's email_log insert hits the mocked db.query
// whenever the SMTP server answers, stealing results a later test queued
// (issue #9).
process.env.SMTP_HOST = "";
// SENTRY_DSN: the route tests trigger 500s on purpose (dbFailures.test.js),
// which would be reported to the real Sentry project (issue #40).
process.env.SENTRY_DSN = "";
// REDIS_URL: every route test would connect to a real Redis and keep
// rate-limit counters there, shared between parallel Jest workers (issue #40).
process.env.REDIS_URL = "";
