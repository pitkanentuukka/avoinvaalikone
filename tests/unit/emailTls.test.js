// On port 587 nodemailer upgrades with STARTTLS only if the server offers it.
// Without requireTLS, a server that doesn't (or an attacker who strips it from
// the EHLO reply) gets the SMTP credentials and every message, magic links
// included, in plaintext (issue #192). TLS is required for every host except
// the local dev mail catchers, which have none. The decision is made on the
// host, not NODE_ENV: Compose defaults NODE_ENV to production even for local
// dev with mailpit, and a plain-Node production may leave it unset.
jest.mock("../../src/db/pool");
jest.mock("nodemailer");

const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "NODE_ENV"];

// The transport is created once per process, so each case loads a fresh copy
// of src/email.js (and of the nodemailer mock it calls), sends one message and
// returns the options the transport was created with.
async function transportOptions(env) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let nodemailer, email;
    jest.isolateModules(() => {
      nodemailer = require("nodemailer");
      nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue({}), verify: jest.fn() });
      require("../../src/db/pool").query.mockResolvedValue({ rows: [] });
      email = require("../../src/email");
    });
    await email.sendCandidateLinkEmail({ id: "c1", name: "M", email: "m@example.fi", token: "t" }, "P", "https://x");
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    return nodemailer.createTransport.mock.calls[0][0];
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("SMTP transport encryption", () => {
  test("a provider host requires STARTTLS", async () => {
    const options = await transportOptions({ NODE_ENV: "production", SMTP_HOST: "in-v3.mailjet.com", SMTP_PORT: "587" });
    expect(options).toMatchObject({ secure: false, requireTLS: true });
  });

  test("…also when NODE_ENV is unset (plain-Node production)", async () => {
    const options = await transportOptions({ SMTP_HOST: "smtp.example.fi", SMTP_PORT: "587" });
    expect(options.requireTLS).toBe(true);
  });

  test("implicit TLS (SMTP_SECURE=true) is encrypted from the start", async () => {
    const options = await transportOptions({ NODE_ENV: "production", SMTP_HOST: "smtp.example.fi", SMTP_PORT: "465", SMTP_SECURE: "true" });
    expect(options).toMatchObject({ secure: true, requireTLS: false });
  });

  // Compose dev: NODE_ENV defaults to production, SMTP_HOST to mailpit (no TLS).
  test.each(["mailpit", "localhost", "127.0.0.1", "::1", "MailPit"])(
    "the dev mail catcher %s doesn't require TLS, even with NODE_ENV=production",
    async (host) => {
      const options = await transportOptions({ NODE_ENV: "production", SMTP_HOST: host, SMTP_PORT: "1025" });
      expect(options.requireTLS).toBe(false);
    }
  );

  // Only those exact names: anything else is treated as a real server.
  test.each(["vaalikone-mailpit", "localhost.", "mailpit.example.fi"])(
    "%s isn't exempt",
    async (host) => {
      const options = await transportOptions({ SMTP_HOST: host, SMTP_PORT: "1025" });
      expect(options.requireTLS).toBe(true);
    }
  );
});
