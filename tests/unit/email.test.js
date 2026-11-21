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
    setEnv({ NODE_ENV: "production", SMTP_USER: undefined, SMTP_FROM: "noreply@example.org" });
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
    setEnv({ NODE_ENV: "production", SMTP_USER: "u", SMTP_FROM: "noreply@example.org" });
    transportMock.verify.mockResolvedValue(true);
    await verifySmtp();
    expect(warn).not.toHaveBeenCalled();
  });
});
