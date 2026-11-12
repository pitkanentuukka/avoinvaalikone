// Runs before every test file (jest.setupFiles in package.json).
//
// src/index.js loads .env with dotenv, and a developer .env usually sets
// SMTP_HOST. A test file that forgets jest.mock("../../src/email") would then
// send real mail, and each send's email_log insert hits the mocked db.query
// whenever the SMTP server answers, stealing results a later test queued
// (issue #9). dotenv never overwrites a variable that is already set, so an
// empty value keeps email disabled; tests of the SMTP path set it themselves.
process.env.SMTP_HOST = "";
