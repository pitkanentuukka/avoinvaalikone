jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const PARTY_TOKEN = "vihre-t-abc12345";
const PARTY = { id: "party-uuid-1111-1111-111111111111", name: "Vihreät", token: PARTY_TOKEN, email: null };
const CANDIDATE_ID = "550e8400-e29b-41d4-a716-446655440000";
const QUESTION_ID = "660e8400-e29b-41d4-a716-446655440000";

beforeAll(() => {
  process.env.ADMIN_SECRET = "test-admin-secret";
});

beforeEach(() => {
  resetDbMocks();
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

// ─── GET /api/candidates/party/:partyToken ────────────────────────────────────

describe("GET /api/candidates/party/:partyToken", () => {
  test("bad token → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // requirePartyToken lookup

    const res = await request(app).get("/api/candidates/party/bad-token");
    expect(res.status).toBe(404);
  });

  test("happy path → 200 { party, candidates }", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    db.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID, name: "Eeva", answer_count: 5 }] });

    const res = await request(app).get(`/api/candidates/party/${PARTY_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("party");
    expect(res.body).toHaveProperty("candidates");
    expect(res.body.party.name).toBe(PARTY.name);
  });
});

// ─── POST /api/candidates/party/:partyToken ───────────────────────────────────

describe("POST /api/candidates/party/:partyToken", () => {
  test("missing name → 400", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const res = await request(app)
      .post(`/api/candidates/party/${PARTY_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nimi vaaditaan/i);
  });

  test("name too long → 400", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const res = await request(app)
      .post(`/api/candidates/party/${PARTY_TOKEN}`)
      .send({ name: "a".repeat(256) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("happy path → 201 with new candidate", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const newCandidate = { id: CANDIDATE_ID, name: "Eeva", photo_url: null, bio: null, created_at: new Date() };
    db.query.mockResolvedValueOnce({ rows: [newCandidate] });

    const res = await request(app)
      .post(`/api/candidates/party/${PARTY_TOKEN}`)
      .send({ name: "Eeva" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Eeva");
  });
});

// ─── PUT /api/candidates/party/:partyToken/candidates/:id/answers ─────────────

describe("PUT /api/candidates/party/:token/candidates/:id/answers", () => {
  const url = `/api/candidates/party/${PARTY_TOKEN}/candidates/${CANDIDATE_ID}/answers`;

  test("missing answers body → 400", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID }] }); // ownership check

    const res = await request(app).put(url).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Vastaukset vaaditaan/i);
  });

  test("candidate not in party → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [] }); // ownership check fails

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2 } } });
    expect(res.status).toBe(404);
  });

  test("happy path with 2 valid answers → 200 { saved: 2 }", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID }] }) // ownership check
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // UPSERT answer 1
      .mockResolvedValueOnce({}) // UPSERT answer 2
      .mockResolvedValueOnce({}) // UPDATE timestamp
      .mockResolvedValueOnce({}); // COMMIT

    const QUESTION_ID2 = "770e8400-e29b-41d4-a716-446655440000";
    const res = await request(app)
      .put(url)
      .send({
        answers: {
          [QUESTION_ID]: { value: 2, explanation: "Kommentti" },
          [QUESTION_ID2]: { value: 4 },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 2 });
    expect(client.release).toHaveBeenCalled();
  });

  test("DB error → ROLLBACK called and client.release() still called", async () => {
    db.query.mockResolvedValueOnce({ rows: [PARTY] }); // requirePartyToken
    const client = buildMockClient();
    const dbErr = new Error("DB failure");
    client.query
      .mockResolvedValueOnce({ rows: [{ id: CANDIDATE_ID }] }) // ownership check
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(dbErr); // UPSERT fails

    const res = await request(app)
      .put(url)
      .send({ answers: { [QUESTION_ID]: { value: 2 } } });

    const rollbackCall = client.query.mock.calls.find(([sql]) => sql === "ROLLBACK");
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
