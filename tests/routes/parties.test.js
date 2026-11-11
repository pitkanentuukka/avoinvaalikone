jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail } = require("../../src/email");

const ADMIN_SECRET = "test-admin-secret";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const authHeader = `Bearer ${ADMIN_SECRET}`;

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  db.query.mockReset();
  sendCandidateLinkEmail.mockReset();
  sendCandidateLinkEmail.mockResolvedValue();
});

// ─── Auth checks ──────────────────────────────────────────────────────────────

describe("Admin auth on party routes", () => {
  test("GET / without auth → 401", async () => {
    const res = await request(app).get("/api/admin/parties");
    expect(res.status).toBe(401);
  });

  test("GET / with wrong token → 403", async () => {
    const res = await request(app)
      .get("/api/admin/parties")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(403);
  });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe("GET /api/admin/parties", () => {
  test("happy path → 200 with party array", async () => {
    const parties = [{ id: VALID_UUID, name: "Testi", token: "abc", email: null, created_at: new Date().toISOString() }];
    db.query.mockResolvedValueOnce({ rows: parties });

    const res = await request(app)
      .get("/api/admin/parties")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(parties);
  });
});

// ─── POST / ───────────────────────────────────────────────────────────────────

describe("POST /api/admin/parties", () => {
  test("missing name → 400", async () => {
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nimi vaaditaan/i);
  });

  test("name too long (>100 chars) → 400", async () => {
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "a".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("happy path → 201 with new party including token", async () => {
    const party = {
      id: VALID_UUID,
      name: "Vihreät",
      token: "vihre-t-abc12345",
      email: null,
      created_at: new Date().toISOString(),
    };
    db.query.mockResolvedValueOnce({ rows: [party] });

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Vihreät", token: expect.any(String) });
  });

  test("duplicate name → 409", async () => {
    const err = new Error("duplicate");
    err.code = "23505";
    db.query.mockRejectedValueOnce(err);

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/jo olemassa/i);
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

describe("DELETE /api/admin/parties/:id", () => {
  test("invalid UUID param → 400", async () => {
    const res = await request(app)
      .delete("/api/admin/parties/not-a-uuid")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete(`/api/admin/parties/${VALID_UUID}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ei löytynyt/i);
  });

  test("happy path → 200 { deleted: true }", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete(`/api/admin/parties/${VALID_UUID}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });
});

// ─── POST / — email validation ────────────────────────────────────────────────

describe("POST /api/admin/parties — email validation", () => {
  test("invalid email → 400", async () => {
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
  });

  test("email too long (>255 chars) → 400", async () => {
    // 252 + "@b.fi" = 256 chars, exceeds 255 limit
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät", email: "a".repeat(252) + "@b.fi" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("valid email → included in 201 response", async () => {
    const party = { id: VALID_UUID, name: "Vihreät", token: "vihre-t-abc12345", email: "vihrea@example.fi", created_at: new Date().toISOString() };
    db.query.mockResolvedValueOnce({ rows: [party] });

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät", email: "vihrea@example.fi" });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("vihrea@example.fi");
  });

  test("non-conflict DB error → 500", async () => {
    db.query.mockRejectedValueOnce(new Error("connection lost"));

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät" });
    expect(res.status).toBe(500);
  });
});

// ─── POST /:id/token ──────────────────────────────────────────────────────────

describe("POST /api/admin/parties/:id/token", () => {
  test("without auth → 401", async () => {
    const res = await request(app).post(`/api/admin/parties/${VALID_UUID}/token`);
    expect(res.status).toBe(401);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/admin/parties/${VALID_UUID}/token`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });

  test("happy path → 200 with a fresh token in the party's slug format", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ name: "Vihreät" }] })
      .mockImplementationOnce((sql, [token]) => Promise.resolve({ rows: [{ id: VALID_UUID, name: "Vihreät", token }] }));

    const res = await request(app)
      .post(`/api/admin/parties/${VALID_UUID}/token`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^vihreat-[A-Za-z0-9_-]{32}$/);
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE parties SET token/);
  });
});

// ─── GET /:id/candidates ──────────────────────────────────────────────────────

describe("GET /api/admin/parties/:id/candidates", () => {
  test("without auth → 401", async () => {
    const res = await request(app).get(`/api/admin/parties/${VALID_UUID}/candidates`);
    expect(res.status).toBe(401);
  });

  test("returns the party's candidates including their personal tokens", async () => {
    const candidates = [{ id: VALID_UUID, name: "Maija", email: null, constituency: "Helsingin vaalipiiri", token: "abc", answer_count: "3" }];
    db.query.mockResolvedValueOnce({ rows: candidates });

    const res = await request(app)
      .get(`/api/admin/parties/${VALID_UUID}/candidates`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(candidates);
    expect(db.query.mock.calls[0][1]).toEqual([VALID_UUID]);
  });
});

// ─── POST /:id/send-candidate-links ───────────────────────────────────────────

describe("POST /api/admin/parties/:id/send-candidate-links", () => {
  const originalSmtp = process.env.SMTP_HOST;
  afterEach(() => {
    if (originalSmtp === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = originalSmtp;
  });

  test("without auth → 401", async () => {
    const res = await request(app).post(`/api/admin/parties/${VALID_UUID}/send-candidate-links`);
    expect(res.status).toBe(401);
  });

  test("SMTP not configured → 503, nothing sent", async () => {
    delete process.env.SMTP_HOST;

    const res = await request(app)
      .post(`/api/admin/parties/${VALID_UUID}/send-candidate-links`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(503);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("party not found → 404", async () => {
    process.env.SMTP_HOST = "smtp.example.fi";
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/admin/parties/${VALID_UUID}/send-candidate-links`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });

  test("emails every candidate with an address and reports the rest", async () => {
    process.env.SMTP_HOST = "smtp.example.fi";
    const withEmail = { id: "c1", name: "Maija", email: "maija@example.fi", token: "t1" };
    const withoutEmail = { id: "c2", name: "Matti", email: null, token: "t2" };
    db.query
      .mockResolvedValueOnce({ rows: [{ name: "Vihreät" }] })
      .mockResolvedValueOnce({ rows: [withEmail, withoutEmail] });

    const res = await request(app)
      .post(`/api/admin/parties/${VALID_UUID}/send-candidate-links`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 1, withoutEmail: 1 });
    expect(sendCandidateLinkEmail).toHaveBeenCalledTimes(1);
    expect(sendCandidateLinkEmail).toHaveBeenCalledWith(withEmail, "Vihreät", expect.any(String));
  });
});
