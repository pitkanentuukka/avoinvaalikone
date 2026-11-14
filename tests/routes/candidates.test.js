jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail } = require("../../src/email");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const PARTY_TOKEN = "vihre-t-abc12345";
const REGISTRATION_TOKEN = "a".repeat(48);
const CANDIDATE_TOKEN = "c".repeat(48);
const PARTY = { id: "party-uuid-1111-1111-111111111111", name: "Vihreät", token: PARTY_TOKEN, email: null, registration_token: REGISTRATION_TOKEN };
const CANDIDATE_ID = "550e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID = "660e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID2 = "770e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_AUTH = { id: CANDIDATE_ID, party_id: PARTY.id, party_name: PARTY.name };
const PROFILE = { name: "Eeva Ehdokas", email: "eeva@example.fi", constituency: "Helsingin vaalipiiri" };

beforeAll(() => {
  process.env.ADMIN_SECRET = "test-admin-secret";
});

beforeEach(() => {
  resetDbMocks();
  sendCandidateLinkEmail.mockReset();
  delete process.env.SMTP_HOST;
});

// ─── GET /api/candidates ──────────────────────────────────────────────────────

describe("GET /api/candidates", () => {
  test("happy path → 200 with candidate list", async () => {
    const candidates = [
      { id: CANDIDATE_ID, name: "Eeva Ehdokas", photo_url: null, bio: null, created_at: new Date(), party_id: PARTY.id, party_name: PARTY.name },
    ];
    db.query.mockResolvedValueOnce({ rows: candidates });

    const res = await request(app).get("/api/candidates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Eeva Ehdokas");
  });
});

// ─── GET /api/candidates/:id ──────────────────────────────────────────────────

describe("GET /api/candidates/:id", () => {
  test("invalid UUID → 400", async () => {
    const res = await request(app).get("/api/candidates/not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/candidates/${CANDIDATE_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ei löytynyt/i);
  });

  test("happy path → 200 with answers dict", async () => {
    const candidate = { id: CANDIDATE_ID, name: "Eeva", photo_url: null, bio: null, created_at: new Date(), party_id: PARTY.id, party_name: PARTY.name };
    const answers = [{ question_id: QUESTION_ID, value: 3, explanation: "Kommentti", answered_at: new Date() }];
    db.query.mockResolvedValueOnce({ rows: [candidate] });
    db.query.mockResolvedValueOnce({ rows: answers });

    const res = await request(app).get(`/api/candidates/${CANDIDATE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.answers).toHaveProperty(QUESTION_ID);
    expect(res.body.answers[QUESTION_ID].value).toBe(3);
  });
});

// ─── Party token: management access ───────────────────────────────────────────

describe("GET /api/candidates/party/:partyToken", () => {
  test("bad token → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // requirePartyToken lookup

    const res = await request(app).get("/api/candidates/party/bad-token");
    expect(res.status).toBe(404);
  });

  test("happy path → 200 with registration link and no candidate tokens", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, name: "Eeva", email: "eeva@example.fi", answer_count: 5 }] });

    const res = await request(app).get(`/api/candidates/party/${PARTY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.party).toEqual({ id: PARTY.id, name: PARTY.name, registrationToken: REGISTRATION_TOKEN });
    expect(res.body.candidates).toHaveLength(1);
    // The party must never see candidate tokens — that would let it edit answers.
    const [, listSql] = db.query.mock.calls[1];
    expect(db.query.mock.calls[1][0]).not.toMatch(/c\.token/);
    expect(listSql).toEqual([PARTY.id]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("Party token can no longer edit candidates", () => {
  test.each([
    ["post", `/api/candidates/party/${PARTY_TOKEN}`],
    ["put", `/api/candidates/party/${PARTY_TOKEN}/candidates/${CANDIDATE_ID}`],
    ["put", `/api/candidates/party/${PARTY_TOKEN}/candidates/${CANDIDATE_ID}/answers`],
  ])("%s %s → 404", async (method, url) => {
    db.query.mockResolvedValue({ rows: [PARTY] });
    const res = await request(app)[method](url).send({ ...PROFILE, answers: { [QUESTION_ID]: { value: 2 } } });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/candidates/party/:partyToken/registration-token", () => {
  test("rotates the registration link", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    db.query.mockResolvedValueOnce({ rows: [{ registration_token: "b".repeat(48) }] });

    const res = await request(app).post(`/api/candidates/party/${PARTY_TOKEN}/registration-token`);
    expect(res.status).toBe(200);
    expect(res.body.registrationToken).toBe("b".repeat(48));
    expect(db.query.mock.calls[1][0]).toMatch(/registration_token = DEFAULT/);
  });
});

describe("POST /api/candidates/party/:partyToken/candidates/:id/send-link", () => {
  const url = `/api/candidates/party/${PARTY_TOKEN}/candidates/${CANDIDATE_ID}/send-link`;

  test("candidate not in party → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post(url);
    expect(res.status).toBe(404);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("candidate without email → 409", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, name: "Eeva", email: null, token: CANDIDATE_TOKEN }] });
    const res = await request(app).post(url);
    expect(res.status).toBe(409);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("email failure → 502", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, name: "Eeva", email: "eeva@example.fi", token: CANDIDATE_TOKEN }] });
    sendCandidateLinkEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const res = await request(app).post(url);
    expect(res.status).toBe(502);
  });

  test("happy path → link emailed to the candidate's own address, not returned", async () => {
    const candidate = { id: CANDIDATE_ID, name: "Eeva", email: "eeva@example.fi", token: CANDIDATE_TOKEN };
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rows: [candidate] });
    sendCandidateLinkEmail.mockResolvedValueOnce();
    const res = await request(app).post(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(sendCandidateLinkEmail).toHaveBeenCalledWith(candidate, PARTY.name, expect.any(String));
  });
});

describe("DELETE /api/candidates/party/:partyToken/candidates/:id", () => {
  const url = `/api/candidates/party/${PARTY_TOKEN}/candidates/${CANDIDATE_ID}`;

  test("candidate not in party → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(app).delete(url);
    expect(res.status).toBe(404);
  });

  test("happy path → deleted, scoped to the party", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] });
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).delete(url);
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1]).toEqual([CANDIDATE_ID, PARTY.id]);
  });
});

// ─── Registration link: self-registration ─────────────────────────────────────

describe("GET /api/candidates/register/:registrationToken", () => {
  test("bad token → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/api/candidates/register/bad");
    expect(res.status).toBe(404);
  });

  test("happy path → party name only", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: PARTY.id, name: PARTY.name }] });
    const res = await request(app).get(`/api/candidates/register/${REGISTRATION_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ party: { name: PARTY.name } });
  });
});

describe("POST /api/candidates/register/:registrationToken", () => {
  const url = `/api/candidates/register/${REGISTRATION_TOKEN}`;
  const regParty = () => db.query.mockResolvedValueOnce({ rows: [{ id: PARTY.id, name: PARTY.name }] });

  test.each([
    ["missing name", { ...PROFILE, name: "" }, /nimi vaaditaan/i],
    ["name too long", { ...PROFILE, name: "a".repeat(256) }, /liian pitkä/i],
    ["missing constituency", { ...PROFILE, constituency: undefined }, /vaalipiiri vaaditaan/i],
    ["missing email", { ...PROFILE, email: undefined }, /sähköpostiosoite vaaditaan/i],
    ["invalid email", { ...PROFILE, email: "not-an-email" }, /virheellinen/i],
    ["email too long", { ...PROFILE, email: "a".repeat(252) + "@b.fi" }, /liian pitkä/i],
    ["photoUrl too long", { ...PROFILE, photoUrl: "https://example.com/" + "a".repeat(490) }, /liian pitkä/i],
    ["invalid photoUrl", { ...PROFILE, photoUrl: "javascript:alert(1)" }, /virheellinen/i],
    ["bio too long", { ...PROFILE, bio: "a".repeat(1001) }, /liian pitkä/i],
    ["non-string name", { ...PROFILE, name: ["x"] }, /nimi vaaditaan/i],
  ])("%s → 400", async (_, body, msg) => {
    regParty();
    const res = await request(app).post(url).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
  });

  test("happy path → 201 with the candidate's personal token", async () => {
    regParty();
    db.query.mockResolvedValueOnce({ rows: [] }); // no existing registration
    const created = { id: CANDIDATE_ID, ...PROFILE, photo_url: null, bio: null, token: CANDIDATE_TOKEN, created_at: new Date() };
    db.query.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app).post(url).send(PROFILE);
    expect(res.status).toBe(201);
    expect(res.body.token).toBe(CANDIDATE_TOKEN);
    expect(db.query.mock.calls[2][1][0]).toBe(PARTY.id);
    // No SMTP configured → no email attempted (the link is shown on screen).
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("happy path with SMTP → link also emailed", async () => {
    process.env.SMTP_HOST = "smtp.example.fi";
    regParty();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, ...PROFILE, token: CANDIDATE_TOKEN }] });
    sendCandidateLinkEmail.mockResolvedValueOnce();

    const res = await request(app).post(url).send(PROFILE);
    expect(res.status).toBe(201);
    expect(sendCandidateLinkEmail).toHaveBeenCalledTimes(1);
  });

  test("same name + email again → 409, existing link re-sent, no duplicate", async () => {
    const existing = { id: CANDIDATE_ID, name: PROFILE.name, email: PROFILE.email, token: CANDIDATE_TOKEN };
    regParty();
    db.query.mockResolvedValueOnce({ rows: [existing] });
    sendCandidateLinkEmail.mockResolvedValueOnce();

    const res = await request(app).post(url).send(PROFILE);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/lähetimme/i);
    expect(res.body).not.toHaveProperty("token");
    expect(sendCandidateLinkEmail).toHaveBeenCalledWith(existing, PARTY.name, expect.any(String));
    expect(db.query).toHaveBeenCalledTimes(2); // no INSERT
  });

  test("invalid constituency (CHECK violation) → 400", async () => {
    regParty();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockRejectedValueOnce(Object.assign(new Error("check"), { code: "23514" }));
    const res = await request(app).post(url).send({ ...PROFILE, constituency: "Narnia" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vaalipiiri/i);
  });
});

// ─── Candidate token: own profile and answers ─────────────────────────────────

describe("GET /api/candidates/me/:candidateToken", () => {
  test("bad token → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/api/candidates/me/bad");
    expect(res.status).toBe(404);
  });

  test("happy path → own profile, party and answers", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, ...PROFILE, photo_url: null, bio: null }] });
    db.query.mockResolvedValueOnce({ rows: [{ question_id: QUESTION_ID, value: 1, explanation: "", answered_at: new Date() }] });

    const res = await request(app).get(`/api/candidates/me/${CANDIDATE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(PROFILE.email);
    expect(res.body.party).toEqual({ id: PARTY.id, name: PARTY.name });
    expect(res.body.answers[QUESTION_ID].value).toBe(1);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("PUT /api/candidates/me/:candidateToken", () => {
  const url = `/api/candidates/me/${CANDIDATE_TOKEN}`;

  test("bad token → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).put(url).send(PROFILE);
    expect(res.status).toBe(404);
  });

  test("validation error → 400", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const res = await request(app).put(url).send({ ...PROFILE, bio: "a".repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("happy path → updates only the token's own candidate", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, ...PROFILE, bio: "Bio" }] });

    const res = await request(app).put(url).send({ ...PROFILE, bio: "Bio", id: "someone-else" });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Bio");
    const params = db.query.mock.calls[1][1];
    expect(params[params.length - 1]).toBe(CANDIDATE_ID);
  });

  // #17: profile and answers are saved together, so a rejected answer
  // doesn't leave the profile change stored behind an error message.
  describe("with answers", () => {
    const isProfileUpdate = ([sql]) => /UPDATE candidates\s+SET name/.test(sql);

    test("invalid answer → 400, profile not updated", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      // Answered if the route updates the profile outside the transaction.
      db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, ...PROFILE, bio: "Uusi bio" }] });
      const client = buildMockClient();
      client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] })
        .mockResolvedValue({});

      const res = await request(app)
        .put(url)
        .send({ ...PROFILE, bio: "Uusi bio", answers: { [QUESTION_ID]: { value: 7 } } });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Ydinvoimaa on lisättävä");
      expect([...db.query.mock.calls, ...client.query.mock.calls].filter(isProfileUpdate)).toHaveLength(0);
      expect(client.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });

    test("profile validation error → 400 before any answer is touched", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();

      const res = await request(app)
        .put(url)
        .send({ ...PROFILE, email: "ei-osoite", answers: { [QUESTION_ID]: { value: 2 } } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sähköposti/i);
      expect(client.query).not.toHaveBeenCalled();
    });

    test("invalid constituency → 400, answers rolled back", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      const checkViolation = Object.assign(new Error("check"), { code: "23514" });
      client.query.mockImplementation(async (sql) => {
        if (/^SELECT id, statement FROM questions/.test(sql)) return { rows: [{ id: QUESTION_ID, statement: "S" }] };
        if (/UPDATE candidates\s+SET name/.test(sql)) throw checkViolation;
        return {};
      });

      const res = await request(app)
        .put(url)
        .send({ ...PROFILE, constituency: "Atlantis", answers: { [QUESTION_ID]: { value: 2 } } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/vaalipiiri/i);
      const sqls = client.query.mock.calls.map(([sql]) => sql);
      expect(sqls).toContain("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    test("happy path → profile and answers committed in one transaction", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      client.query.mockImplementation(async (sql) => {
        if (/^SELECT id, statement FROM questions/.test(sql)) return { rows: [{ id: QUESTION_ID, statement: "S" }] };
        if (/UPDATE candidates\s+SET name/.test(sql)) return { rows: [{ id: CANDIDATE_ID, ...PROFILE, bio: "Bio" }] };
        return {};
      });

      const res = await request(app)
        .put(url)
        .send({ ...PROFILE, bio: "Bio", answers: { [QUESTION_ID]: { value: 3, explanation: "Koska" }, [QUESTION_ID2]: { value: 1 } } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ bio: "Bio", saved: 1, skipped: [QUESTION_ID2] });

      const sqls = client.query.mock.calls.map(([sql]) => sql);
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      // Lock order: questions, then the candidate row, then the answers. The
      // admin delete/merge paths and PUT .../answers lock in the same order.
      const lockAt = sqls.findIndex((sql) => /FROM questions[\s\S]*FOR KEY SHARE/.test(sql));
      const profileAt = sqls.findIndex((sql) => /UPDATE candidates\s+SET name/.test(sql));
      const upsertAt = sqls.findIndex((sql) => /INSERT INTO candidate_answers/.test(sql));
      expect(lockAt).toBeGreaterThan(0);
      expect(profileAt).toBeGreaterThan(lockAt);
      expect(upsertAt).toBeGreaterThan(profileAt);
      const profileUpdate = client.query.mock.calls.find(isProfileUpdate);
      expect(profileUpdate[1][profileUpdate[1].length - 1]).toBe(CANDIDATE_ID);
      const upsert = client.query.mock.calls.find(([sql]) => /INSERT INTO candidate_answers/.test(sql));
      expect(upsert[1]).toEqual([CANDIDATE_ID, QUESTION_ID, 3, "Koska"]);
      // The profile update goes through the transaction, not the pool.
      expect(db.query.mock.calls.filter(isProfileUpdate)).toHaveLength(0);
      expect(client.release).toHaveBeenCalled();
    });

    test("nothing rated (answers: {}) → profile saved in the transaction", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      client.query.mockImplementation(async (sql) =>
        /UPDATE candidates\s+SET name/.test(sql) ? { rows: [{ id: CANDIDATE_ID, ...PROFILE }] } : {}
      );

      const res = await request(app).put(url).send({ ...PROFILE, answers: {} });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: PROFILE.name, saved: 0, skipped: [] });
      const sqls = client.query.mock.calls.map(([sql]) => sql);
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls.some((sql) => /candidate_answers/.test(sql))).toBe(false);
    });

    test("answers: null → plain profile update", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, ...PROFILE }] });
      const client = buildMockClient();

      const res = await request(app).put(url).send({ ...PROFILE, answers: null });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(PROFILE.name);
      expect(res.body).not.toHaveProperty("saved");
      expect(client.query).not.toHaveBeenCalled();
    });

    // A candidate removed by their party between the token lookup and the save.
    test("candidate gone by the time of the update → 404, rolled back", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      client.query.mockImplementation(async (sql) => (/UPDATE candidates\s+SET name/.test(sql) ? { rows: [] } : {}));

      const res = await request(app).put(url).send({ ...PROFILE, answers: {} });
      expect(res.status).toBe(404);
      const sqls = client.query.mock.calls.map(([sql]) => sql);
      expect(sqls).toContain("ROLLBACK");
      expect(sqls).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    test("candidate gone, with answers rated → 404 before any answer is written", async () => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      const fkViolation = Object.assign(new Error("fk"), { code: "23503" });
      client.query.mockImplementation(async (sql) => {
        if (/^SELECT id, statement FROM questions/.test(sql)) return { rows: [{ id: QUESTION_ID, statement: "S" }] };
        if (/UPDATE candidates\s+SET name/.test(sql)) return { rows: [] };
        if (/INSERT INTO candidate_answers/.test(sql)) throw fkViolation;
        return {};
      });

      const res = await request(app).put(url).send({ ...PROFILE, answers: { [QUESTION_ID]: { value: 2 } } });
      expect(res.status).toBe(404);
      const sqls = client.query.mock.calls.map(([sql]) => sql);
      expect(sqls.some((sql) => /INSERT INTO candidate_answers/.test(sql))).toBe(false);
      expect(sqls).toContain("ROLLBACK");
    });

    test.each([["a string", "x"], ["a number", 3], ["an array", []]])("answers as %s → 400", async (_, answers) => {
      db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
      const client = buildMockClient();
      const res = await request(app).put(url).send({ ...PROFILE, answers });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Vastaukset/);
      expect(client.query).not.toHaveBeenCalled();
      expect(db.query.mock.calls.filter(isProfileUpdate)).toHaveLength(0);
    });
  });
});

describe("PUT /api/candidates/me/:candidateToken/answers", () => {
  const url = `/api/candidates/me/${CANDIDATE_TOKEN}/answers`;

  test.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "x"],
    ["a number", 3],
    ["a boolean", false],
    ["an empty array", []],
    ["a non-empty array", ["x"]],
  ])("answers as %s → 400 before checking out a connection (#51)", async (_, answers) => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    // Before the fix, arrays reach the save and return 200.
    client.query.mockResolvedValue({ rowCount: 1 });

    const res = await request(app).put(url).send({ answers });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Vastaukset ovat virheellisessä muodossa" });
    expect(db.getClient).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  test("an empty answers object remains a valid save", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValue({ rowCount: 1 });

    const res = await request(app).put(url).send({ answers: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 0, skipped: [] });
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO candidate_answers/.test(sql))).toBe(false);
  });

  test("happy path with 2 valid answers → 200 { saved: 2 }", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID }, { id: QUESTION_ID2 }] }) // existing questions
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}) // UPSERT answer 1
      .mockResolvedValueOnce({}) // UPSERT answer 2
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .put(url)
      .send({
        answers: {
          [QUESTION_ID]: { value: 2, explanation: "Kommentti" },
          [QUESTION_ID2]: { value: 4 },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 2, skipped: [] });
    expect(client.query.mock.calls[3][1][0]).toBe(CANDIDATE_ID);
    expect(client.release).toHaveBeenCalled();
  });

  test("unknown question and null answer are skipped, not a 500; unknown one is reported", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID }] }) // QUESTION_ID2 no longer exists
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: null, [QUESTION_ID2]: { value: 3 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 0, skipped: [QUESTION_ID2] });
  });

  test("explanation over 500 characters → 400 naming the question, nothing saved", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [
        { id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" },
        { id: QUESTION_ID2, statement: "Bensaveroa on laskettava" },
      ],
    });

    const res = await request(app)
      .put(url)
      .send({
        answers: {
          [QUESTION_ID]: { value: 2, explanation: "a".repeat(501) },
          [QUESTION_ID2]: { value: 4, explanation: "Lyhyt" },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
    expect(res.body.error).toContain("Ydinvoimaa on lisättävä");
    expect(res.body.error).not.toContain("Bensaveroa");
    // The whole save is rejected: BEGIN, the check, ROLLBACK — no upserts.
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalled();
  });

  test("explanation of exactly 500 characters is saved", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}) // UPSERT
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2, explanation: "a".repeat(500) } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 1, skipped: [] });
    expect(client.query.mock.calls[3][1]).toEqual([CANDIDATE_ID, QUESTION_ID, 2, "a".repeat(500)]);
  });

  test("length is measured after trimming surrounding whitespace", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}) // UPSERT
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2, explanation: `  ${"a".repeat(500)}  ` } } });
    expect(res.status).toBe(200);
    expect(client.query.mock.calls[3][1][3]).toBe("a".repeat(500));
  });

  test("numeric string value is accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}) // UPSERT
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: { value: "2" } } });
    expect(res.status).toBe(200);
    expect(client.query.mock.calls[3][1]).toEqual([CANDIDATE_ID, QUESTION_ID, 2, ""]);
  });

  test.each([5, false, ["x"]])("non-string explanation %p → 400, nothing saved", async (explanation) => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] });

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: { value: 2, explanation } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Ydinvoimaa on lisättävä");
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test("several offending questions → plural message listing each", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [
        { id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" },
        { id: QUESTION_ID2, statement: "Bensaveroa on laskettava" },
      ],
    });

    const res = await request(app)
      .put(url)
      .send({
        answers: {
          [QUESTION_ID]: { value: 2, explanation: "a".repeat(501) },
          [QUESTION_ID2]: { value: 1, explanation: "b".repeat(501) },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kysymyksissä/);
    expect(res.body.error).toContain("Ydinvoimaa on lisättävä");
    expect(res.body.error).toContain("Bensaveroa on laskettava");
  });

  test.each([5, -1, "abc", null])("invalid value %p → 400 naming the question, nothing saved", async (value) => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [
        { id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" },
        { id: QUESTION_ID2, statement: "Bensaveroa on laskettava" },
      ],
    });

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 3 }, [QUESTION_ID2]: { value } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
    expect(res.body.error).toContain("Bensaveroa on laskettava");
    expect(res.body.error).not.toContain("Ydinvoimaa");
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalled();
  });

  test("long question statements are shortened in the error message", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    const statement = "Väittämä ".repeat(50).trim();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement }] });

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2, explanation: "a".repeat(501) } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(statement.slice(0, 40));
    expect(res.body.error).not.toContain(statement);
  });

  test("null answer for a missing question is not reported as skipped", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // QUESTION_ID no longer exists
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: null } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 0, skipped: [] });
  });

  test.each([3, "2", true])("non-object answer %p → 400 naming the question", async (answer) => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] });

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: answer } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Ydinvoimaa on lisättävä");
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test("a skipped question doesn't let an invalid answer through: 400, nothing saved", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] }); // QUESTION_ID2 gone

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 9 }, [QUESTION_ID2]: { value: 2 } } });
    expect(res.status).toBe(400);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test("invalid value and too-long explanation → both reported", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [
        { id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" },
        { id: QUESTION_ID2, statement: "Bensaveroa on laskettava" },
      ],
    });

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 9 }, [QUESTION_ID2]: { value: 2, explanation: "a".repeat(501) } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Virheellinen vastaus kysymyksessä: "Ydinvoimaa on lisättävä". ' +
      'Liian pitkä perustelu (maksimi: 500 merkkiä) kysymyksessä: "Bensaveroa on laskettava"'
    );
  });

  // A question deleted or merged between the existence check and the upsert
  // must end up in `skipped`, not a foreign-key violation (#16): the check runs
  // inside the transaction and key-share locks the rows, so a concurrent delete
  // waits for the save. The lock is taken in id order, the same order every
  // question delete path locks in (merge, reject, set and link removal), so
  // they can't deadlock.
  test("existence check runs inside the transaction and locks the questions in id order", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID }] }) // existing questions
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE timestamp
      .mockResolvedValueOnce({}) // UPSERT
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: { value: 2 } } });
    expect(res.status).toBe(200);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/FROM questions\b[\s\S]*ORDER BY id\s+FOR KEY SHARE/);
    // Candidate row before the answers, as in PUT /me with answers, so the two
    // routes can't deadlock against each other (#17 review round 3).
    expect(sqls[2]).toMatch(/UPDATE candidates SET updated_at/);
    expect(sqls[3]).toMatch(/INSERT INTO candidate_answers/);
  });

  test("candidate gone since the token lookup → 404, nothing written", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID }] }) // existing questions
      .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE timestamp: candidate removed
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: { value: 2 } } });
    expect(res.status).toBe(404);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => /INSERT INTO candidate_answers/.test(sql))).toBe(false);
    expect(sqls).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  test("validation failure after the lock → ROLLBACK, 400, client released", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID, statement: "Ydinvoimaa on lisättävä" }] })
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app).put(url).send({ answers: { [QUESTION_ID]: { value: 9 } } });
    expect(res.status).toBe(400);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", expect.any(String), "ROLLBACK"]);
    expect(client.release).toHaveBeenCalled();
  });

  test("DB error → ROLLBACK called and client.release() still called", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: QUESTION_ID }] }) // existing questions
      .mockRejectedValueOnce(new Error("DB failure")); // UPSERT fails

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2 } } });

    const rollbackCall = client.query.mock.calls.find(([sql]) => sql === "ROLLBACK");
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });

  // A failed COMMIT has already ended the transaction (#18).
  test("COMMIT fails → 500, no ROLLBACK, client released once", async () => {
    db.query.mockResolvedValueOnce({ rows: [CANDIDATE_AUTH] });
    const client = buildMockClient();
    client.query.mockImplementation((sql) => {
      if (sql === "COMMIT") return Promise.reject(new Error("Connection terminated unexpectedly"));
      if (/FROM questions/.test(sql)) return Promise.resolve({ rows: [{ id: QUESTION_ID }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2 } } });

    expect(res.status).toBe(500);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
