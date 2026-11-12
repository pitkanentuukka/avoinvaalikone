const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

// src/index.js loads .env with dotenv. A developer .env that sets SMTP_HOST
// would make every test file that forgets jest.mock("../../src/email") send
// real mail, and the email_log insert that follows each send lands on the
// mocked db.query later, stealing results another test queued (issue #9).
test("a .env that sets SMTP_HOST doesn't enable email in tests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaalikone-env-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "SMTP_HOST=smtp.example.fi\n");
  try {
    dotenv.config({ path: envFile });
    expect(process.env.SMTP_HOST).toBe("");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
