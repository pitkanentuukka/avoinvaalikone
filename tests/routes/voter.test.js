jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID2 = "660e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_ID = "770e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  db.query.mockReset();
});

// ─── Algorithm correctness ────────────────────────────────────────────────────

describe("POST /api/voter/match — algorithm", () => {
  const makeMatch = (voterAnswers, candidateAnswers, weights = {}) =>
    request(app)
      .post("/api/voter/match")
      .send({ answers: voterAnswers, weights });

  function setupDb(voterAnswers, candidateAnswerRows) {
    // First query: candidate_answers JOIN questions
    db.query.mockResolvedValueOnce({ rows: candidateAnswerRows });
    // Second query: SELECT candidates+parties
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: CANDIDATE_ID,
          name: "Testi Ehdokas",
          photo_url: null,
          bio: null,
          party_id: "aaa",
          party_name: "Testi Puolue",
        },
      ],
    });
  }

  test("identical answers → match = 100", async () => {
    setupDb(
      { [VALID_UUID]: 2 },
      [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]
    );
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBe(100);
  });

  test("opposite answers (0 vs 4) → match = 0", async () => {
    setupDb(
      { [VALID_UUID]: 0 },
      [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 4, explanation: "" }]
    );
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBe(0);
  });

  test("diff = 2, one question → match = 50", async () => {
    setupDb(
      { [VALID_UUID]: 0 },
      [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]
    );
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBe(50);
  });

  test("weight=3 on matching q, weight=0 on differing q → weighted result", async () => {
    // Q1: voter=2, cand=2 (same), weight=3 → w=(3||1)+1=4, similarity=1 → contributes 4
    // Q2: voter=0, cand=4 (diff=4), weight=0 → w=(0||1)+1=2 (0 is falsy!), similarity=0 → contributes 0
    // total = 4/(4+2) ≈ 0.667 = 67%
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" },
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID2, value: 4, explanation: "" },
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: CANDIDATE_ID,
          name: "Testi Ehdokas",
          photo_url: null,
          bio: null,
          party_id: "aaa",
          party_name: "Testi Puolue",
        },
      ],
    });
    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: 3, [VALID_UUID2]: 0 },
      });
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBe(67);
  });

  test("default weight (missing key) → treated as weight=1, factor=2", async () => {
    // voter=4, cand=2, diff=2, similarity=0.5, weight missing→factor=2
    // score = 0.5*2 / 2 = 0.5 = 50%
    setupDb(
      { [VALID_UUID]: 4 },
      [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]
    );
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 } }); // no weights
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBe(50);
  });

  test("empty candidateIds (no one answered) → returns []", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate_answers
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
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body[0].match).toBeGreaterThanOrEqual(res.body[1].match);
    expect(res.body[0].id).toBe(CANDIDATE_ID); // 100% match first
  });

  test("answeredCount reflects only overlapping questions", async () => {
    // Voter answers 2 questions, candidate only answered one
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" },
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [
        { id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" },
      ],
    });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 3 } });
    expect(res.status).toBe(200);
    expect(res.body[0].answeredCount).toBe(1);
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

  test("valid questionSetIds → DB called with $2 param", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [VALID_UUID2] });
    expect(res.status).toBe(200);
    // DB should have been called with params array containing both question IDs and set IDs
    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(2);
    expect(params[1]).toEqual([VALID_UUID2]);
  });
});
