jest.mock("../../src/db/pool");
jest.mock("nodemailer");

const nodemailer = require("nodemailer");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail, sendApprovedQuestionSetNotificationToParty } = require("../../src/email");

const sendMail = jest.fn();
nodemailer.createTransport.mockReturnValue({ sendMail });

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
