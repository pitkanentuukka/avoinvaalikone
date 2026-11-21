// On port 587 nodemailer upgrades with STARTTLS only if the server offers it.
// Without requireTLS, a server that doesn't (or an attacker who strips it from
// the EHLO reply) gets the SMTP credentials and every message, magic links
// included, in plaintext (issue #192).
jest.mock("../../src/db/pool");
jest.mock("nodemailer");

// The transport is created once per process, so each case loads a fresh copy
// of src/email.js (and of the nodemailer mock it calls).
function transportOptions(env) {
  const saved = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: "smtp.example.fi", SMTP_SECURE: "", NODE_ENV: "test" }, env);
  try {
    let options;
    jest.isolateModules(() => {
      const nodemailer = require("nodemailer");
      nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue({}), verify: jest.fn() });
      require("../../src/db/pool").query.mockResolvedValue({ rows: [] });
      const { sendCandidateLinkEmail } = require("../../src/email");
      sendCandidateLinkEmail({ id: "c1", name: "M", email: "m@example.fi", token: "t" }, "P", "https://x");
      options = nodemailer.createTransport.mock.calls[0][0];
    });
    return options;
  } finally {
    process.env = saved;
  }
}

describe("SMTP transport encryption", () => {
  test("production requires STARTTLS on a non-implicit-TLS port", () => {
    expect(transportOptions({ NODE_ENV: "production", SMTP_PORT: "587" })).toMatchObject({ secure: false, requireTLS: true });
  });

  test("production with implicit TLS (SMTP_SECURE=true) is encrypted from the start", () => {
    expect(transportOptions({ NODE_ENV: "production", SMTP_PORT: "465", SMTP_SECURE: "true" })).toMatchObject({ secure: true });
  });

  // Local dev talks to mailpit, which has no TLS.
  test("development doesn't require TLS", () => {
    expect(transportOptions({ NODE_ENV: "development", SMTP_PORT: "1025" }).requireTLS).toBeFalsy();
  });
});
