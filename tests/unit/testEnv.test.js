const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../src/db/pool");
jest.mock("../../src/email");

// Point src/index.js's own dotenv.config() call (with whatever options it
// passes, e.g. a future override: true) at a .env that sets SMTP_HOST.
const mockEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaalikone-env-"));
const mockEnvFile = path.join(mockEnvDir, ".env");
fs.writeFileSync(mockEnvFile, "SMTP_HOST=smtp.example.fi\n");

jest.mock("dotenv", () => {
  const actual = jest.requireActual("dotenv");
  return { ...actual, config: (options = {}) => actual.config({ ...options, path: mockEnvFile }) };
});

afterAll(() => fs.rmSync(mockEnvDir, { recursive: true, force: true }));

// A developer .env that sets SMTP_HOST would make every test file that forgets
// jest.mock("../../src/email") send real mail, and the email_log insert that
// follows each send lands on the mocked db.query later, stealing results
// another test queued (issue #9).
test("a .env that sets SMTP_HOST doesn't enable email in tests", () => {
  require("../../src/index");
  expect(process.env.SMTP_HOST).toBe("");
});
