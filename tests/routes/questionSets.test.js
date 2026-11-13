jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");
const email = require("../../src/email");
const { resetDbMocks, buildMockClient } = require("../helpers/mockDb");

const ADMIN_SECRET = "test-admin-secret";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const authHeader = `Bearer ${ADMIN_SECRET}`;

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  resetDbMocks();
  // Real sends would log to email_log through the mocked db.query and steal
  // later tests' mock results (when .env enables SMTP locally).
  for (const fn of Object.values(email)) {
    if (jest.isMockFunction(fn)) fn.mockReset().mockResolvedValue();
  }
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
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/väittämä/i);
  });

  test("ngoName too long → 400", async () => {
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
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/otsikko/i);
  });

  test("title too long → 400", async () => {
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "a".repeat(256), questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("invalid ngoEmail → 400", async () => {
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", ngoEmail: "not-email", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
  });

  test("ngoEmail too long → 400", async () => {
    // 252 + "@b.fi" = 256 chars, exceeds 255 limit
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", ngoEmail: "a".repeat(252) + "@b.fi", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("invalid logoUrl → 400", async () => {
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", logoUrl: "javascript:alert(1)", questions: ["Väittämä 1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/virheellinen/i);
  });

  test("logoUrl too long → 400", async () => {
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

  test("statement over 500 characters → 400 naming it, nothing created", async () => {
    const long = "Pitkä väittämä " + "a".repeat(500);
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: ["Väittämä 1", long] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
    expect(res.body.error).toContain("Pitkä väittämä");
    expect(res.body.error).not.toContain("Väittämä 1");
    expect(db.getClient).not.toHaveBeenCalled();
  });

  test("over-long statement in object form → 400; several → plural message", async () => {
    const res = await request(app)
      .post("/api/question-sets")
      .send({
        ngoName: "TestiJärjestö",
        title: "Sarja",
        questions: [{ statement: "Eka " + "a".repeat(500) }, { statement: "Toka " + "b".repeat(500) }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Väittämät ovat liian pitkiä/);
    expect(res.body.error).toContain("Eka");
    expect(res.body.error).toContain("Toka");
    expect(db.getClient).not.toHaveBeenCalled();
  });

  test("statement of exactly 500 characters → 201", async () => {
    const client = buildMockClient();
    const qs = { id: VALID_UUID, ngo_name: "TestiJärjestö", title: "Sarja", status: "pending" };
    const stmt = "a".repeat(500);
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [qs] }) // INSERT question_set
      .mockResolvedValueOnce({ rows: [{ id: "q1", statement: stmt }] }) // INSERT question
      .mockResolvedValueOnce({}) // INSERT question_set_questions
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: [stmt] });
    expect(res.status).toBe(201);
    expect(res.body.questions).toHaveLength(1);
  });

  test.each([null, ""])("ngoEmail and logoUrl %p → 201, stored as null", async (value) => {
    const client = buildMockClient();
    const qs = { id: VALID_UUID, ngo_name: "TestiJärjestö", title: "Sarja", status: "pending" };
    client.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [qs] }) // INSERT question_set
      .mockResolvedValueOnce({ rows: [{ id: "q1", statement: "Väittämä 1" }] }) // INSERT question
      .mockResolvedValueOnce({}) // INSERT question_set_questions
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", ngoEmail: value, logoUrl: value, questions: ["Väittämä 1"] });
    expect(res.status).toBe(201);
    const [, setParams] = client.query.mock.calls[1];
    expect(setParams[1]).toBeNull();
    expect(setParams[2]).toBeNull();
  });

  test("no non-empty statements → 400, no empty question set created", async () => {
    const res = await request(app)
      .post("/api/question-sets")
      .send({ ngoName: "TestiJärjestö", title: "Sarja", questions: ["   ", ""] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/väittämä/i);
    expect(db.getClient).not.toHaveBeenCalled();
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

// Staged = approved + hidden
const stagedSet = { ...pendingSet, status: "approved", hidden: true };

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
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviews/i);
  });

  test("empty reviews array → 400", async () => {
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [] });
    expect(res.status).toBe(400);
  });

  test("question set not found → 404", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})            // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT FOR UPDATE → not found
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [{ questionId: Q1, rejected: false }] });
    expect(res.status).toBe(404);
  });

  test("editedStatement too long → 400", async () => {
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({ reviews: [{ questionId: Q1, rejected: false, editedStatement: "a".repeat(501) }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
    expect(db.getClient).not.toHaveBeenCalled();
  });

  test("all questions accepted → status approved, hidden=true → 200", async () => {
    const client = buildMockClient();
    const updated = { ...stagedSet, reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                                          // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                                                     // SELECT FOR UPDATE
      // no needOriginalIds (no edits, no rejections) → skip SELECT originals
      // no UPDATE per-question edits
      // no DELETE
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Väittämä 1" }, { id: Q2, statement: "Väittämä 2" }] }) // SELECT remaining
      .mockResolvedValueOnce({ rows: [updated] })                                                        // UPDATE status + hidden
      .mockResolvedValueOnce({});                                                                        // COMMIT

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
    expect(res.body.hidden).toBe(true);
  });

  test("question edited → UPDATE called, stays staged → 200", async () => {
    const client = buildMockClient();
    const updated = { ...stagedSet, reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                                          // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                                                     // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Alkuperäinen" }] })                          // SELECT originals (edited)
      .mockResolvedValueOnce({})                                                                         // UPDATE questions SET statement (edit Q1)
      // no DELETE
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Muokattu" }, { id: Q2, statement: "Väittämä 2" }] }) // SELECT remaining
      .mockResolvedValueOnce({ rows: [updated] })                                                        // UPDATE status + hidden
      .mockResolvedValueOnce({});                                                                        // COMMIT

    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({
        reviews: [
          { questionId: Q1, rejected: false, editedStatement: "Muokattu" },
          { questionId: Q2, rejected: false },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.hidden).toBe(true);

    const updateCalls = client.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE questions")
    );
    expect(updateCalls).toHaveLength(1);
  });

  test("some questions rejected → deleted, remainder staged → 200", async () => {
    const client = buildMockClient();
    const updated = { ...stagedSet, reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                  // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                              // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q2 }] })                              // lock deletable questions
      .mockResolvedValueOnce({ rows: [{ id: Q2, statement: "Väittämä 2" }] })    // SELECT originals (rejected)
      // no edits
      .mockResolvedValueOnce({})                                                  // DELETE FROM question_set_questions (unlink)
      .mockResolvedValueOnce({ rows: [{ id: Q2 }] })                              // lock orphan candidates
      .mockResolvedValueOnce({})                                                  // DELETE FROM questions (orphan cleanup)
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Väittämä 1" }] })    // SELECT remaining
      .mockResolvedValueOnce({ rows: [updated] })                                 // UPDATE status + hidden
      .mockResolvedValueOnce({});                                                 // COMMIT

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
    expect(res.body.hidden).toBe(true);

    // Rejecting a question now unlinks it from the set and then deletes the
    // canonical question if it is orphaned → two DELETE statements.
    const deleteCalls = client.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE")
    );
    expect(deleteCalls).toHaveLength(2);

    // The rejected question is locked in id order before anything changes, so
    // a concurrent answer save can't deadlock with it (#16).
    expect(client.query.mock.calls[2]).toEqual([expect.stringMatching(/ORDER BY id FOR UPDATE/), [[Q2]]]);
  });

  test("all questions rejected → status rejected, not hidden → 200", async () => {
    const client = buildMockClient();
    const updated = { ...pendingSet, status: "rejected", hidden: false, reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                                                    // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                                               // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q1 }, { id: Q2 }] })                                    // lock deletable questions
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Väittämä 1" }, { id: Q2, statement: "Väittämä 2" }] }) // SELECT originals (rejected)
      // no edits
      .mockResolvedValueOnce({})                                                                    // DELETE FROM question_set_questions (unlink)
      .mockResolvedValueOnce({ rows: [{ id: Q1 }, { id: Q2 }] })                                    // lock orphan candidates
      .mockResolvedValueOnce({})                                                                    // DELETE FROM questions (orphan cleanup)
      .mockResolvedValueOnce({ rows: [] })                                                          // SELECT remaining → empty
      .mockResolvedValueOnce({ rows: [updated] })                                                   // UPDATE status
      .mockResolvedValueOnce({});                                                                   // COMMIT

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

  // A merge deletes the duplicate; locking both questions in id order before
  // any change keeps a concurrent answer save from deadlocking with it (#16).
  test("inline merge locks duplicate and canonical in id order before changing anything", async () => {
    const client = buildMockClient();
    const updated = { ...stagedSet, reviewed_at: new Date().toISOString() };
    client.query
      .mockResolvedValueOnce({})                                              // BEGIN
      .mockResolvedValueOnce({ rows: [pendingSet] })                          // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: Q1 }, { id: VALID_UUID }] })     // lock deletable questions
      .mockResolvedValueOnce({})                                              // merge: INSERT candidate_answers
      .mockResolvedValueOnce({})                                              // merge: INSERT voter_responses
      .mockResolvedValueOnce({})                                              // merge: INSERT links
      .mockResolvedValueOnce({})                                              // merge: DELETE question
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, statement: "Kanoninen" }, { id: Q2, statement: "Väittämä 2" }] }) // SELECT remaining
      .mockResolvedValueOnce({ rows: [updated] })                             // UPDATE status + hidden
      .mockResolvedValueOnce({});                                             // COMMIT

    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/review`)
      .set("Authorization", authHeader)
      .send({
        reviews: [
          { questionId: Q1, rejected: false, duplicateOf: VALID_UUID },
          { questionId: Q2, rejected: false },
        ],
      });

    expect(res.status).toBe(200);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[2]).toMatch(/FROM questions\b[\s\S]*ORDER BY id FOR UPDATE/);
    expect(client.query.mock.calls[2][1][0]).toEqual(expect.arrayContaining([Q1, VALID_UUID]));
    expect(sqls[3]).toMatch(/INSERT INTO candidate_answers/);
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

// ─── PATCH /api/admin/question-sets/:id/unhide (publish) ─────────────────────

describe("PATCH /api/admin/question-sets/:id/unhide", () => {
  test("not admin → 401", async () => {
    const res = await request(app).patch(`/api/admin/question-sets/${VALID_UUID}/unhide`);
    expect(res.status).toBe(401);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/unhide`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 200 with hidden=false", async () => {
    const published = { ...stagedSet, hidden: false };
    db.query.mockResolvedValueOnce({ rows: [published] });
    const res = await request(app)
      .patch(`/api/admin/question-sets/${VALID_UUID}/unhide`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body.hidden).toBe(false);
  });
});

// ─── POST /api/admin/question-sets/:id/questions ─────────────────────────────

describe("POST /api/admin/question-sets/:id/questions", () => {
  test("not admin → 401", async () => {
    const res = await request(app).post(`/api/admin/question-sets/${VALID_UUID}/questions`);
    expect(res.status).toBe(401);
  });

  test("invalid set UUID → 400", async () => {
    const res = await request(app)
      .post("/api/admin/question-sets/bad-id/questions")
      .set("Authorization", authHeader)
      .send({ statement: "Uusi väittämä" });
    expect(res.status).toBe(400);
  });

  test("missing statement → 400", async () => {
    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/väittämä/i);
  });

  test("statement too long → 400", async () => {
    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({ statement: "a".repeat(501) });
    expect(res.status).toBe(400);
  });

  test("set not found → 404", async () => {
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [] }); // SELECT set
    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({ statement: "Uusi väittämä" });
    expect(res.status).toBe(404);
  });

  test("set is live (not staged) → 409", async () => {
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [{ ...stagedSet, hidden: false }] }); // SELECT set
    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({ statement: "Uusi väittämä" });
    expect(res.status).toBe(409);
  });

  test("happy path → 201 with new question", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({ rows: [stagedSet] })                              // SELECT set
      .mockResolvedValueOnce({})                                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ max: 2 }] })                              // SELECT MAX(sort_order)
      .mockResolvedValueOnce({ rows: [{ id: Q1, statement: "Uusi väittämä" }] }) // INSERT question
      .mockResolvedValueOnce({})                                                  // INSERT link
      .mockResolvedValueOnce({});                                                 // COMMIT

    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({ statement: "Uusi väittämä" });

    expect(res.status).toBe(201);
    expect(res.body.statement).toBe("Uusi väittämä");
    expect(res.body.sortOrder).toBe(3);
  });

  // Issue #18: the set check runs before BEGIN, so there is nothing to roll back.
  test("set lookup fails before BEGIN → 500, no ROLLBACK, client released", async () => {
    const client = buildMockClient();
    client.query.mockRejectedValueOnce(new Error("DB down")); // SELECT set
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/admin/question-sets/${VALID_UUID}/questions`)
      .set("Authorization", authHeader)
      .send({ statement: "Uusi väittämä" });
    console.error.mockRestore();
    expect(res.status).toBe(500);
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ─── DELETE /api/admin/question-sets/:id/questions/:questionId ───────────────

describe("DELETE /api/admin/question-sets/:id/questions/:questionId", () => {
  test("not admin → 401", async () => {
    const res = await request(app).delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`);
    expect(res.status).toBe(401);
  });

  test("invalid set UUID → 400", async () => {
    const res = await request(app)
      .delete(`/api/admin/question-sets/bad-id/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("invalid question UUID → 400", async () => {
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/bad-id`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("set not found → 404", async () => {
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [] }); // SELECT set
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("set is live (not staged) → 409", async () => {
    const client = buildMockClient();
    client.query.mockResolvedValueOnce({ rows: [{ ...stagedSet, hidden: false }] }); // SELECT set
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(409);
  });

  test("question not found in set → 404", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({ rows: [stagedSet] }) // SELECT set
      .mockResolvedValueOnce({})                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 });      // DELETE link → no rows
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
  });

  test("happy path → 204", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({ rows: [stagedSet] }) // SELECT set
      .mockResolvedValueOnce({})                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })       // DELETE link
      .mockResolvedValueOnce({ rows: [{ id: Q1 }] }) // lock orphan candidate
      .mockResolvedValueOnce({})                    // DELETE orphan question
      .mockResolvedValueOnce({});                   // COMMIT
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(204);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[3]).toMatch(/ORDER BY q\.id FOR UPDATE/);
    expect(sqls[4]).toMatch(/DELETE FROM questions/);
  });

  // The 404 was decided on data already read, and pg discards the dead
  // client on release, so a failed early-return ROLLBACK doesn't turn it
  // into a 500 (#18).
  test("question not found, ROLLBACK fails on a dead connection → still 404, client released once", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({ rows: [stagedSet] })                             // SELECT set
      .mockResolvedValueOnce({})                                                // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 })                                   // DELETE link → no rows
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly")); // ROLLBACK
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(404);
    expect(client.query.mock.calls.map(([sql]) => sql).filter((s) => s === "ROLLBACK")).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // Issue #18: the set check runs before BEGIN, so there is nothing to roll back.
  test("set lookup fails before BEGIN → 500, no ROLLBACK, client released", async () => {
    const client = buildMockClient();
    client.query.mockRejectedValueOnce(new Error("DB down")); // SELECT set
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}/questions/${Q1}`)
      .set("Authorization", authHeader);
    console.error.mockRestore();
    expect(res.status).toBe(500);
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ─── DELETE /api/admin/question-sets/:id ─────────────────────────────────────

describe("DELETE /api/admin/question-sets/:id", () => {
  // Orphaned questions are locked in id order before the DELETE, which would
  // otherwise lock them in scan order and could deadlock with a concurrent
  // answer save that holds some of them (#16).
  test("happy path → orphans locked in id order before they're deleted → 204", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})                                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ question_id: Q2 }, { question_id: Q1 }] }) // SELECT linked
      .mockResolvedValueOnce({ rowCount: 1 })                               // DELETE set
      .mockResolvedValueOnce({ rows: [{ id: Q1 }, { id: Q2 }] })            // lock orphan candidates
      .mockResolvedValueOnce({})                                            // DELETE orphan questions
      .mockResolvedValueOnce({});                                           // COMMIT
    const res = await request(app)
      .delete(`/api/admin/question-sets/${VALID_UUID}`)
      .set("Authorization", authHeader);
    expect(res.status).toBe(204);
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    // Only orphans are locked: a question another set shares isn't deleted.
    expect(sqls[3]).toMatch(/FROM questions q\b[\s\S]*NOT EXISTS[\s\S]*ORDER BY q\.id FOR UPDATE/);
    expect(client.query.mock.calls[3][1]).toEqual([[Q2, Q1]]);
    expect(sqls[4]).toMatch(/DELETE FROM questions/);
    expect(sqls[5]).toBe("COMMIT");
  });
});

// ─── POST /api/admin/question-sets/merge-questions ───────────────────────────

describe("POST /api/admin/question-sets/merge-questions", () => {
  test("not admin → 401", async () => {
    const res = await request(app).post("/api/admin/question-sets/merge-questions");
    expect(res.status).toBe(401);
  });

  test("invalid keepId → 400", async () => {
    const res = await request(app)
      .post("/api/admin/question-sets/merge-questions")
      .set("Authorization", authHeader)
      .send({ keepId: "bad-id", dropIds: [Q1] });
    expect(res.status).toBe(400);
  });

  test("empty dropIds → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/admin/question-sets/merge-questions")
      .set("Authorization", authHeader)
      .send({ keepId: VALID_UUID, dropIds: [] });
    expect(res.status).toBe(400);
  });

  test("dropIds contains keepId → 400", async () => {
    buildMockClient();
    const res = await request(app)
      .post("/api/admin/question-sets/merge-questions")
      .set("Authorization", authHeader)
      .send({ keepId: VALID_UUID, dropIds: [VALID_UUID] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itseensä/i);
  });

  test("a question does not exist → 404", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // SELECT FOR UPDATE → only 1 of 2 found
    const res = await request(app)
      .post("/api/admin/question-sets/merge-questions")
      .set("Authorization", authHeader)
      .send({ keepId: VALID_UUID, dropIds: [Q1] });
    expect(res.status).toBe(404);
  });

  test("happy path → 200 with merged count", async () => {
    const client = buildMockClient();
    client.query
      .mockResolvedValueOnce({})                                              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: Q1 }] })      // SELECT FOR UPDATE (both exist)
      .mockResolvedValueOnce({})                                              // merge: INSERT candidate_answers
      .mockResolvedValueOnce({})                                              // merge: INSERT voter_responses
      .mockResolvedValueOnce({})                                              // merge: INSERT links
      .mockResolvedValueOnce({})                                              // merge: DELETE question
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, statement: "Kanoninen" }] }) // SELECT canonical
      .mockResolvedValueOnce({ rows: [{ id: "s1", title: "Sarja", ngo_name: "NGO" }] }) // SELECT set links
      .mockResolvedValueOnce({});                                             // COMMIT

    const res = await request(app)
      .post("/api/admin/question-sets/merge-questions")
      .set("Authorization", authHeader)
      .send({ keepId: VALID_UUID, dropIds: [Q1] });

    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(1);
    expect(res.body.sets).toHaveLength(1);
    // Locked in id order, like the candidate answer save (#16), so the two
    // can't deadlock.
    expect(client.query.mock.calls[1][0]).toMatch(/ORDER BY id\s+FOR UPDATE/);
  });
});
