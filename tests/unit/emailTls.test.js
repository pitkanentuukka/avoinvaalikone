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

  // SMTP_SECURE used to count only the exact string "true", and port 465 never
  // implied it, so a provider's implicit-TLS port was dialled in plaintext and
  // every send timed out waiting for a greeting (issue #199).
  test.each(["true", "TRUE", "True", "1", "yes", "YES", "on", " true "])(
    "SMTP_SECURE=%p enables implicit TLS, also on a port other than 465",
    async (value) => {
      const options = await transportOptions({ SMTP_HOST: "smtp.example.fi", SMTP_PORT: "2465", SMTP_SECURE: value });
      expect(options).toMatchObject({ secure: true, requireTLS: false });
    }
  );

  test.each(["false", "FALSE", "0", "no", "off", "", undefined])(
    "SMTP_SECURE=%p on port 587 uses STARTTLS",
    async (value) => {
      const env = { SMTP_HOST: "smtp.example.fi", SMTP_PORT: "587" };
      if (value !== undefined) env.SMTP_SECURE = value;
      const options = await transportOptions(env);
      expect(options).toMatchObject({ secure: false, requireTLS: true });
    }
  );

  // Port 465 is implicit TLS (RFC 8314); nothing serves plaintext or STARTTLS
  // there. .env files copied from .env.example before #199 set
  // SMTP_SECURE=false, so an explicit false is overridden too (verifySmtp warns).
  test.each([undefined, "", "false", "0", "no"])(
    "port 465 uses implicit TLS with SMTP_SECURE=%p",
    async (value) => {
      const env = { SMTP_HOST: "smtp.example.fi", SMTP_PORT: "465" };
      if (value !== undefined) env.SMTP_SECURE = value;
      const options = await transportOptions(env);
      expect(options).toMatchObject({ secure: true, requireTLS: false });
    }
  );

  // The port is parsed as a number, as nodemailer is given it.
  test.each([" 465", "0465"])("SMTP_PORT=%p is port 465", async (port) => {
    const options = await transportOptions({ SMTP_HOST: "smtp.example.fi", SMTP_PORT: port, SMTP_SECURE: "false" });
    expect(options).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  // An invalid port is replaced by the default, as nodemailer itself would,
  // rather than parsed to its leading digits ("58 7" used to dial 58) (#214).
  test.each([
    ["abc", undefined, 587, false], ["58 7", undefined, 587, false], ["0x1d1", undefined, 587, false],
    ["65536", undefined, 587, false], ["abc", "true", 465, true], ["", undefined, 587, false],
  ])("SMTP_PORT=%p (SMTP_SECURE=%p) dials port %p", async (port, secure, expected, implicitTls) => {
    const env = { SMTP_HOST: "smtp.example.fi", SMTP_PORT: port };
    if (secure !== undefined) env.SMTP_SECURE = secure;
    const options = await transportOptions(env);
    expect(options).toMatchObject({ port: expected, secure: implicitTls, requireTLS: !implicitTls });
  });

  test("an unrecognised SMTP_SECURE on port 465 still uses implicit TLS", async () => {
    const options = await transportOptions({ SMTP_HOST: "smtp.example.fi", SMTP_PORT: "465", SMTP_SECURE: "ture" });
    expect(options).toMatchObject({ secure: true, requireTLS: false });
  });

  // A typo neither enables implicit TLS nor turns off the STARTTLS requirement.
  test("an unrecognised SMTP_SECURE on port 587 still requires STARTTLS", async () => {
    const options = await transportOptions({ SMTP_HOST: "smtp.example.fi", SMTP_PORT: "587", SMTP_SECURE: "ture" });
    expect(options).toMatchObject({ secure: false, requireTLS: true });
  });
});
