jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const ADMIN_SECRET = "test-admin-secret";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const authHeader = `Bearer ${ADMIN_SECRET}`;

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  resetDbMocks();
});

// ─── GET /api/question-sets ───────────────────────────────────────────────────

describe("GET /api/question-sets", () => {
  test("approved sets with questions → 200", async () => {
    const sets = [{ id: VALID_UUID, ngo_name: "TestiJärjestö", title: "Sarja 1", status: "approved", submitted_at: new Date() }];
    const questions = [{ id: "q1", question_set_id: VALID_UUID, statement: "Väittämä 1", sort_order: 1 }];
    db.query.mockResolvedValueOnce({ rows: sets });
    db.query.mockResolvedValueOnce({ rows: questions });

    const res = await request(app).get("/api/question-sets");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].questions).toHaveLength(1);
  });

  test("no approved sets → 200 []", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/api/question-sets");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── POST /api/question-sets ──────────────────────────────────────────────────

describe("POST /api/question-sets", () => {
  test("missing ngoName → 400", async () => {
    const client = buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ title: "Sarja", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nimi/i);
  });

  test("empty questions array → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/väittämä/i);
  });

  test("ngoName too long → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "a".repeat(256), title: "Sarja", questions: ["Väittämä"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("happy path → 201 and client.release() called", async () => {
    const client = buildMockClient();
    const qs = { id: VALID_UUID, ngo_name: "TestiJärjestö", title: "Sarja", status: "pending" };
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [qs] }) // INSERT question_set
      .mockResolvedValueOnce({ rows: [{ id: "q1", statement: "Väittämä 1", sort_order: 1 }] }) // INSERT question
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: ["Väittämä 1"] });

    expect(res.status).toBe(201);
    expect(client.release).toHaveBeenCalled();
  });

  test("DB error mid-transaction → ROLLBACK called and client.release() called", async () => {
    const client = buildMockClient();
    const dbErr = new Error("DB failure");
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(dbErr); // INSERT fails

    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: ["Väittämä 1"] });

    // ROLLBACK should have been called
    const rollbackCall = client.query.mock.calls.find(([sql]) => sql === "ROLLBACK");
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/admin/question-sets (via /admin route) ─────────────────────────

describe("GET /api/admin/question-sets/admin", () => {
  test("all statuses sorted correctly → 200", async () => {
    const sets = [
      { id: "s1", status: "pending", submitted_at: new Date() },
      { id: "s2", status: "approved", submitted_at: new Date() },
    ];
    db.query.mockResolvedValueOnce({ rows: sets });
    db.query.mockResolvedValueOnce({ rows: [] }); // questions

    const res = await request(app)
      .get("/api/admin/question-sets/admin")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test("no auth → 401", async () => {
    const res = await request(app).get("/api/admin/question-sets/admin");
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/admin/question-sets/admin/:id/approve ────────────────────────
// Note: router is mounted at /api/admin/question-sets; route is /admin/:id/approve

describe("PATCH /api/admin/question-sets/admin/:id/approve", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/admin/${VALID_UUID}/approve`);
    expect(res.status).toBe(401);
  });

  test("invalid UUID → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/question-sets/admin/bad-id/approve")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/admin/${VALID_UUID}/approve`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 200", async () => {
    const updated = { id: VALID_UUID, status: "approved" };
    db.query.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/admin/${VALID_UUID}/approve`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });
});

// ─── PATCH /api/admin/question-sets/admin/:id/reject ─────────────────────────

describe("PATCH /api/admin/question-sets/admin/:id/reject", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/admin/${VALID_UUID}/reject`);
    expect(res.status).toBe(401);
  });

  test("invalid UUID → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/question-sets/admin/bad-id/reject")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/admin/${VALID_UUID}/reject`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 200", async () => {
    const updated = { id: VALID_UUID, status: "rejected" };
    db.query.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/admin/${VALID_UUID}/reject`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
});
