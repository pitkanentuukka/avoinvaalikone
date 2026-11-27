jest.mock("../../src/db/pool");
jest.mock("nodemailer");
jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

const nodemailer = require("nodemailer");
const Sentry = require("@sentry/node");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail, sendApprovedQuestionSetNotificationToParty } = require("../../src/email");

const sendMail = jest.fn();
const transportMock = { sendMail, verify: jest.fn() };
nodemailer.createTransport.mockReturnValue(transportMock);

const candidate = { id: "c1", name: "Maija", email: "maija@example.fi", token: "t1" };
const logInsert = () => db.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO email_log"));

beforeAll(() => {
  process.env.SMTP_HOST = "smtp.example.fi";
});

afterAll(() => {
  delete process.env.SMTP_HOST;
});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
});

describe("transport", () => {
  test("one pooled transport is shared by every send", async () => {
    await sendCandidateLinkEmail(candidate, "Vihreät", "https://vaalikone.fi");
    await sendCandidateLinkEmail(candidate, "Vihreät", "https://vaalikone.fi");

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0]).toMatchObject({ pool: true, host: "smtp.example.fi" });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});

describe("email_log", () => {
  test("successful send is recorded as sent against the candidate", async () => {
    await sendCandidateLinkEmail(candidate, "Vihreät", "https://vaalikone.fi");

    expect(sendMail.mock.calls[0][0].to).toBe("maija@example.fi");
    expect(logInsert()[1]).toEqual(["candidate_link", "maija@example.fi", "c1", null, "sent", null]);
  });

  test("failed send is recorded as failed with the error, then rethrown", async () => {
    sendMail.mockRejectedValueOnce(new Error("421 too many connections"));

    await expect(sendCandidateLinkEmail(candidate, "Vihreät", "https://vaalikone.fi"))
      .rejects.toThrow("421 too many connections");
    expect(logInsert()[1]).toEqual(["candidate_link", "maija@example.fi", "c1", null, "failed", "421 too many connections"]);
  });

  test("party mail is recorded against the party", async () => {
    const party = { id: "p1", name: "Vihreät", email: "toimisto@vihreat.fi", token: "pt" };
    await sendApprovedQuestionSetNotificationToParty({ ngo_name: "Järjestö", title: "Sarja" }, 3, party, "https://vaalikone.fi");

    expect(logInsert()[1]).toEqual(["party_new_questions", "toimisto@vihreat.fi", null, "p1", "sent", null]);
  });

  test("a failing log write does not turn a sent email into an error", async () => {
    db.query.mockRejectedValueOnce(new Error("db down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendCandidateLinkEmail(candidate, "Vihreät", "https://vaalikone.fi")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// A wrong SMTP_HOST (the dev default "mailpit" in production) or bad
// credentials otherwise surface only as failed rows in email_log (issue #190).
describe("verifySmtp", () => {
  const { verifySmtp } = require("../../src/email");
  const saved = {};
  let log, warn, error;

  // Set (or, with undefined, delete) env vars for one test; afterEach restores.
  function setEnv(vars) {
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in saved)) saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(() => {
    transportMock.verify.mockReset();
    Sentry.captureMessage.mockReset();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  test("logs a reachable server with its port", async () => {
    setEnv({ SMTP_PORT: undefined });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(log.mock.calls.join(" ")).toContain("smtp.example.fi:587");
    expect(error).not.toHaveBeenCalled();
  });

  test("logs a failed check without throwing, and reports it to Sentry", async () => {
    transportMock.verify.mockRejectedValue(new Error("getaddrinfo ENOTFOUND mailpit"));
    await expect(verifySmtp()).resolves.toBeUndefined();
    expect(error.mock.calls.join(" ")).toContain("ENOTFOUND mailpit");
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND mailpit"), "error");
  });

  test("warns that email is disabled without SMTP_HOST", async () => {
    setEnv({ SMTP_HOST: undefined });
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toMatch(/SMTP_HOST/);
    expect(transportMock.verify).not.toHaveBeenCalled();
  });

  // verify() only logs in when auth is configured, so it passes against a
  // provider that requires auth, and then every send fails.
  test("warns in production when no SMTP credentials are set", async () => {
    setEnv({ NODE_ENV: "production", SMTP_USER: undefined, SMTP_FROM: "noreply@avoinvaalikone.fi" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toMatch(/SMTP_USER/);
  });

  // Plain-Node production has no compose ":?" check for the sender.
  test("warns in production when SMTP_FROM is unset", async () => {
    setEnv({ NODE_ENV: "production", SMTP_USER: "u", SMTP_FROM: undefined });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toMatch(/SMTP_FROM/);
  });

  test("doesn't warn about a complete production configuration", async () => {
    setEnv({ NODE_ENV: "production", SMTP_HOST: "smtp.example.fi", SMTP_PORT: "587",
      SMTP_USER: "u", SMTP_FROM: "noreply@avoinvaalikone.fi" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // .env.example (which operators copy to .env) holds dev values that pass the
  // prod compose file's ":?" checks: a provider host with them left in sends
  // on mailpit's port, from a sender receivers reject.
  test.each([
    ["SMTP_HOST", { SMTP_HOST: "localhost" }],
    ["SMTP_HOST", { SMTP_HOST: "mailpit" }],
    ["SMTP_PORT", { SMTP_PORT: "1025" }],
    ["SMTP_FROM", { SMTP_FROM: "noreply@example.com" }],
    ["SMTP_FROM", { SMTP_FROM: "Vaalikone <noreply@EXAMPLE.org>" }],
    ["ADMIN_EMAIL", { ADMIN_EMAIL: "admin@example.com" }],
  ])("warns in production about a dev or placeholder %s (%o), also to Sentry", async (key, vars) => {
    setEnv({ NODE_ENV: "production", SMTP_HOST: "smtp.example.fi", SMTP_PORT: "587",
      SMTP_USER: "u", SMTP_FROM: "noreply@avoinvaalikone.fi", ...vars });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toContain(key);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining(key), "warning");
  });

  // Port 465 always uses implicit TLS, so an explicit SMTP_SECURE=false there
  // is overridden; say so, whatever NODE_ENV is (issue #199).
  test.each(["false", "0", "NO"])("warns that SMTP_SECURE=%s is ignored on port 465", async (value) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: "465", SMTP_SECURE: value });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toMatch(new RegExp(`SMTP_SECURE=${value}.*465`));
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("SMTP_SECURE"), "warning");
  });

  // On 465 the hint mustn't suggest false, which is ignored there too.
  test.each(["587", "465"])("warns about an unrecognised SMTP_SECURE value on port %s", async (port) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: port, SMTP_SECURE: "ture" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    const warned = warn.mock.calls.join(" ");
    expect(warned).toContain("SMTP_SECURE=ture on tuntematon arvo");
    expect(warned).not.toMatch(/käytä arvoa/);
  });

  // Implicit TLS against a STARTTLS port fails with "wrong version number".
  test.each(["587", "25"])("warns about SMTP_SECURE=true on the STARTTLS port %s", async (port) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: port, SMTP_SECURE: "true" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toMatch(new RegExp(`SMTP_SECURE=true portissa ${port}.*STARTTLS`));
  });

  test.each([
    ["465", undefined], ["465", "true"], ["587", "false"], ["587", ""], ["2465", "1"],
  ])("doesn't warn about port %s with SMTP_SECURE=%p", async (port, value) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: port, SMTP_SECURE: value });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn).not.toHaveBeenCalled();
  });

  // The log names the port nodemailer dials, not the raw setting (#214).
  test.each([[" 2525", "2525"], ["02525", "2525"], ["1", "1"], ["65535", "65535"]])("logs SMTP_PORT=%p as port %s", async (raw, port) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: raw });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(log.mock.calls.join(" ")).toContain(`smtp.example.fi:${port}`);
    expect(warn).not.toHaveBeenCalled();
  });

  // An invalid port is ignored: nodemailer dials 587 (465 with implicit TLS)
  // instead. Say so, and log the port actually used (#214).
  test.each([
    ["abc", undefined, "587"], ["58 7", undefined, "587"], ["587abc", undefined, "587"],
    ["0x1d1", undefined, "587"], ["1.5", undefined, "587"], ["0", undefined, "587"],
    ["65536", undefined, "587"], ["-25", undefined, "587"], ["abc", "true", "465"],
  ])("warns that SMTP_PORT=%p is ignored (SMTP_SECURE=%p) and logs port %s", async (raw, secure, port) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: raw, SMTP_SECURE: secure });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toContain(`SMTP_PORT="${raw}" ei ole kelvollinen porttinumero`);
    expect(warn.mock.calls.join(" ")).toContain(`yhteys avataan porttiin ${port}.`);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("SMTP_PORT"), "warning");
    expect(log.mock.calls.join(" ")).toContain(`smtp.example.fi:${port}`);
  });

  test("the failure log also names the port actually dialled", async () => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: "abc" });
    transportMock.verify.mockRejectedValue(new Error("ETIMEDOUT"));
    await verifySmtp();
    expect(error.mock.calls.join(" ")).toContain("(smtp.example.fi:587)");
  });

  test.each(["", "  "])("treats SMTP_PORT=%p as unset (port 587, no warning)", async (raw) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: raw });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(log.mock.calls.join(" ")).toContain("smtp.example.fi:587");
    expect(warn).not.toHaveBeenCalled();
  });

  // The transport parses these as 1025, mailpit's port (#214).
  test.each([" 1025", "01025", "1025 "])("warns in production about SMTP_PORT=%p as mailpit's port", async (raw) => {
    setEnv({ NODE_ENV: "production", SMTP_HOST: "smtp.example.fi", SMTP_PORT: raw,
      SMTP_USER: "u", SMTP_FROM: "noreply@avoinvaalikone.fi" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toContain(`SMTP_PORT="${raw}" (portti 1025) on kehitysympäristön (mailpit) portti`);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("mailpit"), "warning");
  });

  test.each(["abc", "0", "-1", "2.5"])("warns that SMTP_MAX_CONNECTIONS=%p is ignored", async (raw) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: "587", SMTP_MAX_CONNECTIONS: raw });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn.mock.calls.join(" ")).toContain(`SMTP_MAX_CONNECTIONS="${raw}" ei ole kelvollinen`);
    expect(warn.mock.calls.join(" ")).toContain("käytetään oletusarvoa 3");
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("SMTP_MAX_CONNECTIONS"), "warning");
  });

  test.each(["", "  ", "1", "10"])("doesn't warn about SMTP_MAX_CONNECTIONS=%p", async (raw) => {
    setEnv({ NODE_ENV: "development", SMTP_PORT: "587", SMTP_MAX_CONNECTIONS: raw });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn).not.toHaveBeenCalled();
  });

  test("doesn't warn about dev values outside production", async () => {
    setEnv({ NODE_ENV: "development", SMTP_HOST: "localhost", SMTP_PORT: "1025", SMTP_FROM: "noreply@example.com" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn).not.toHaveBeenCalled();
  });
});
