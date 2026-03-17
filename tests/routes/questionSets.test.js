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

  test("missing title → 400", async () => {
    buildMockClient(); // route calls db.getClient() before validation
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/otsikko/i);
  });

  test("title too long → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "a".repeat(256), questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("invalid ngoEmail → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", ngoEmail: "not-email", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
  });

  test("ngoEmail too long → 400", async () => {
    buildMockClient();
    // 252 + "@b.fi" = 256 chars, exceeds 255 limit
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", ngoEmail: "a".repeat(252) + "@b.fi", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("invalid logoUrl → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", logoUrl: "javascript:alert(1)", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
  });

  test("logoUrl too long → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", logoUrl: "https://example.com/" + "a".repeat(490), questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("questions as objects with statement field → 201", async () => {
    const client = buildMockClient();
    const qs = { id: VALID_UUID, ngo_name: "TestiJärjestö", title: "Sarja", status: "pending" };
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [qs] }) // INSERT question_set
      .mockResolvedValueOnce({ rows: [{ id: "q1", statement: "Väittämä 1", sort_order: 1 }] }) // INSERT question
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: [{ statement: "Väittämä 1" }] });
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

// ─── GET /api/admin/question-sets ────────────────────────────────────────────

describe("GET /api/admin/question-sets", () => {
  test("all statuses sorted correctly → 200", async () => {
    const sets = [
      { id: "s1", status: "pending", submitted_at: new Date() },
      { id: "s2", status: "approved", submitted_at: new Date() },
    ];
    db.query.mockResolvedValueOnce({ rows: sets });
    db.query.mockResolvedValueOnce({ rows: [] }); // questions

    const res = await request(app)
      .get("/api/admin/question-sets")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test("no auth → 401", async () => {
    const res = await request(app).get("/api/admin/question-sets");
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/admin/question-sets/:id/approve ───────────────────────────────

describe("PATCH /api/admin/question-sets/:id/approve", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/${VALID_UUID}/approve`);
    expect(res.status).toBe(401);
  });

  test("invalid UUID → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/question-sets/bad-id/approve")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/approve`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 200", async () => {
    const updated = { id: VALID_UUID, status: "approved" };
    db.query.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/approve`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });
});

// ─── PATCH /api/admin/question-sets/:id/reject ────────────────────────────────

describe("PATCH /api/admin/question-sets/:id/reject", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/${VALID_UUID}/reject`);
    expect(res.status).toBe(401);
  });

  test("invalid UUID → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/question-sets/bad-id/reject")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/reject`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 200", async () => {
    const updated = { id: VALID_UUID, status: "rejected" };
    db.query.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/reject`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
});

// ─── PATCH /api/admin/question-sets/:id/review ───────────────────────────────

const Q1 = "aa000000-0000-0000-0000-000000000001";
const Q2 = "aa000000-0000-0000-0000-000000000002";

const pendingSet = {
  id: VALID_UUID,
  ngo_name: "TestiJärjestö",
  ngo_email: "info@testi.fi",
  title: "Testisarja",
  status: "pending",
};

function buildReviewClient({ remainingCount = 2, updatedStatus = "approved" } = {}) {
  const client = buildMockClient();
  const updated = { ...pendingSet, status: updatedStatus, reviewed_at: new Date().toISOString() };
  client.query
    .mockResolvedValueOnce({})                               // BEGIN
    .mockResolvedValueOnce({ rows: [pendingSet] })           // SELECT … FOR UPDATE
    // (no rejected rows branch by default — callers can override)
    .mockResolvedValueOnce({ rows: [{ count: String(remainingCount) }] }) // COUNT remaining
    .mockResolvedValueOnce({ rows: [updated] })              // UPDATE status
    .mockResolvedValueOnce({});                              // COMMIT
  return { client, updated };
}

describe("PATCH /api/admin/question-sets/:id/review", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/${VALID_UUID}/review`);
    expect(res.status).toBe(401);
  });

  test("invalid UUID → 400", async () => {
    const res = await request(app)
      .patch("/api/admin/question-sets/bad-id/review")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("missing reviews field → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviews/i);
  });

  test("empty reviews array → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [] });
    expect(res.status).toBe(400);
  });

  test("question set not found → 404", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})               // BEGIN
      .mockResolvedValueOnce({ rows: [] });    // SELECT returns nothing
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [{ questionId: Q1, rejected: false }] });
    expect(res.status).toBe(404);
  });

  test("all questions accepted → status approved → 200", async () => {
    const { updated } = buildReviewClient({ remainingCount: 2, updatedStatus: "approved" });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({
        reviews: [
          { questionId: Q1, rejected: false },
          { questionId: Q2, rejected: false },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  test("some questions rejected → deleted, remainder approved → 200", async () => {
    const client = buildMockClient();
    const updated = { ...pendingSet, status: "approved", reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                               // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q2, statement: "Väittämä 2" }] })      // SELECT rejected statements
      .mockResolvedValueOnce({})                                                    // DELETE rejected questions
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })                           // COUNT remaining
      .mockResolvedValueOnce({ rows: [updated] })                                   // UPDATE status
      .mockResolvedValueOnce({});                                                   // COMMIT

    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({
        reviews: [
          { questionId: Q1, rejected: false },
          { questionId: Q2, rejected: true, rejectionReason: "Aihe liian laaja" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    // DELETE must have been called for rejected question
    const deleteCalls = client.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE")
    );
    expect(deleteCalls).toHaveLength(1);
  });

  test("all questions rejected → status rejected → 200", async () => {
    const client = buildMockClient();
    const updated = { ...pendingSet, status: "rejected", reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                           // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                                      // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Väittämä 1" }, { id: Q2, statement: "Väittämä 2" }] }) // SELECT rejected statements
      .mockResolvedValueOnce({})                                                           // DELETE
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })                                  // COUNT remaining → 0
      .mockResolvedValueOnce({ rows: [updated] })                                          // UPDATE status
      .mockResolvedValueOnce({});                                                          // COMMIT

    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({
        reviews: [
          { questionId: Q1, rejected: true, rejectionReason: "Epäasiallinen" },
          { questionId: Q2, rejected: true, rejectionReason: "" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });

  test("DB error → ROLLBACK called, 500 returned, client released", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})                    // BEGIN
      .mockRejectedValueOnce(new Error("DB down")); // SELECT FOR UPDATE fails

    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [{ questionId: Q1, rejected: false }] });

    const rollbackCall = client.query.mock.calls.find(([sql]) => sql === "ROLLBACK");
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
