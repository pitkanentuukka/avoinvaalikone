jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID2 = "660e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_ID = "770e8400-e29b-41d4-a716-446655440000";
const SESSION_UUID = "990e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  db.query.mockReset();
});

// ─── Algorithm correctness ────────────────────────────────────────────────────

describe("POST /api/voter/match — algorithm", () => {
  /**
   * Sets up the 4 DB queries the route runs when candidates have answers:
   * 1. candidate_answers JOIN questions
   * 2. SELECT candidates + parties
   * 3. SELECT gen_random_uuid()
   * 4. INSERT INTO voter_responses
   */
  function setupDb(candidateAnswerRows, candidateRows) {
    const candidates = candidateRows || [
      {
        id: CANDIDATE_ID,
        name: "Testi Ehdokas",
        photo_url: null,
        bio: null,
        party_id: "aaa",
        party_name: "Testi Puolue",
      },
    ];
    db.query.mockResolvedValueOnce({ rows: candidateAnswerRows });
    db.query.mockResolvedValueOnce({ rows: candidates });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });
  }

  test("identical answers → match = 100", async () => {
    setupDb([{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]);
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(100);
  });

  test("opposite answers (0 vs 4) → match = 0", async () => {
    setupDb([{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 4, explanation: "" }]);
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(0);
  });

  test("diff = 2, one question → match = 50", async () => {
    setupDb([{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]);
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
  });

  test("weight=3 on matching q, weight=0 on differing q → weighted result", async () => {
    // Q1: voter=2, cand=2 (same), weight=3 → factor=4, similarity=1 → contributes 4
    // Q2: voter=0, cand=4 (diff=4), weight=0 → treated as 1 (0 is falsy), factor=2, similarity=0 → contributes 0
    // total = 4/(4+2) ≈ 0.667 = 67%
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" },
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID2, value: 4, explanation: "" },
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "Testi Ehdokas", photo_url: null, bio: null, party_id: "aaa", party_name: "Testi Puolue" }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: 3, [VALID_UUID2]: 0 },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(67);
  });

  test("default weight (missing key) → treated as weight=1, factor=2", async () => {
    // voter=4, cand=2, diff=2, similarity=0.5, factor=2 → score=0.5=50%
    setupDb([{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]);
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 } }); // no weights
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
  });

  test("empty candidateIds (no one answered) → returns []", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate_answers, early return
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("two candidates → sorted descending by match", async () => {
    const CAND2 = "880e8400-e29b-41d4-a716-446655440000";
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }, // same as voter
        { candidate_id: CAND2, question_id: VALID_UUID, value: 4, explanation: "" }, // diff=2
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [
        { id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" },
        { id: CAND2, name: "B", photo_url: null, bio: null, party_id: "p1", party_name: "P" },
      ],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBeGreaterThanOrEqual(res.body.results[1].match);
    expect(res.body.results[0].id).toBe(CANDIDATE_ID); // 100% match first
  });

  test("answeredCount reflects only overlapping questions", async () => {
    // Voter answers 2 questions, candidate only answered one
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].answeredCount).toBe(1);
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe("POST /api/voter/match — response shape", () => {
  test("non-empty result includes sessionId and results array", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
    expect(typeof res.body.sessionId).toBe("string");
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  test("result items include expected fields", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 3, explanation: "testi" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "Eeva", photo_url: null, bio: "bio", party_id: "p1", party_name: "Puolue" }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 3 } });
    const item = res.body.results[0];
    expect(item).toHaveProperty("id", CANDIDATE_ID);
    expect(item).toHaveProperty("name", "Eeva");
    expect(item).toHaveProperty("match", 100);
    expect(item).toHaveProperty("answeredCount", 1);
    expect(item).toHaveProperty("partyName", "Puolue");
  });
});

// ─── Anonymous voter response storage ────────────────────────────────────────

describe("POST /api/voter/match — voter response storage", () => {
  test("INSERT INTO voter_responses called with session_id and answer values", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ session_id: SESSION_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });

    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    expect(insertCall[1]).toContain(SESSION_UUID);
    expect(insertCall[1]).toContain(VALID_UUID);
    expect(insertCall[1]).toContain(2);
  });

  test("no voter_responses INSERT when candidates list is empty", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // empty → early return

    await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });

    // Only 1 DB call should have been made (the candidate_answers query)
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("POST /api/voter/match — validation", () => {
  test("empty answers object → 400 'Vastaukset vaaditaan'", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Vastaukset vaaditaan/);
  });

  test("missing answers field → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Vastaukset vaaditaan/);
  });

  test("answer value = 5 → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0-4/);
  });

  test("answer value = -1 → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0-4/);
  });

  test("non-UUID question key → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { "not-a-uuid": 2 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tunnisteet/i);
  });

  test("invalid UUID in questionSetIds → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: ["bad-uuid"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kysymyssarjan tunnisteet/i);
  });

  test("valid questionSetIds → DB called with $2 param containing set IDs", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [VALID_UUID2] });
    expect(res.status).toBe(200);
    // First DB call should have params: [[questionIds], [setIds]]
    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(2);
    expect(params[1]).toEqual([VALID_UUID2]);
  });

  test("boundary answer value = 0 → accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
  });

  test("boundary answer value = 4 → accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 } });
    expect(res.status).toBe(200);
  });

  test("empty questionSetIds array → no filter applied, accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [] });
    expect(res.status).toBe(200);
    // Without filter, only 1 param (voterQuestionIds)
    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(1);
  });
});
