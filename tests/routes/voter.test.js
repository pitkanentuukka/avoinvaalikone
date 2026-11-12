jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID2 = "660e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_ID = "770e8400-e29b-41d4-a716-446655440000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  db.query.mockReset();
});

// ─── Algorithm correctness ────────────────────────────────────────────────────

describe("POST /api/voter/match — algorithm", () => {
  /**
   * Sets up the 4 DB queries the route runs when candidates have answers:
   * 1. SELECT id FROM questions (filter to questions that still exist)
   * 2. candidate_answers JOIN questions
   * 3. SELECT candidates + parties
   * 4. INSERT INTO voter_responses (fire-and-forget; session id comes from
   *    crypto.randomUUID, not the DB)
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
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: candidateAnswerRows });
    db.query.mockResolvedValueOnce({ rows: candidates });
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
    // Q2: voter=0, cand=4 (diff=4), weight=0 → factor=1, similarity=0 → contributes 0
    // total = 4/(4+1) = 0.8 = 80%
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" },
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID2, value: 4, explanation: "" },
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "Testi Ehdokas", photo_url: null, bio: null, party_id: "aaa", party_name: "Testi Puolue" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: 3, [VALID_UUID2]: 0 },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(80);
  });

  test("no weights at all → plain average", async () => {
    // voter=4, cand=2, diff=2, similarity=0.5 → score=0.5=50%
    setupDb([{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }]);
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 } }); // no weights
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
  });

  // The weighting UI shows "somewhat important" (weight 1) as selected for every
  // question the voter hasn't touched, and only sends weights the voter clicked.
  // A missing weight must therefore count exactly like an explicit 1.
  function setupTwoQuestions() {
    // Q1: voter=2, cand=2 → similarity 1; Q2: voter=0, cand=4 → similarity 0
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] });
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 },
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID2, value: 4 },
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "Testi Ehdokas", photo_url: null, bio: null, party_id: "aaa", party_name: "Testi Puolue" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });
  }

  test("missing weight counts the same as the displayed default (weight 1)", async () => {
    // Q1 explicit weight 1 → factor 2; Q2 untouched → factor 2 → 2/4 = 50%
    setupTwoQuestions();
    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: 1 },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
  });

  test("string weights are read like numbers (\"0\" stays 0)", async () => {
    // Q1 weight "0" → factor 1; Q2 weight "1" → factor 2 → 1/3 = 33%
    setupTwoQuestions();
    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: "0", [VALID_UUID2]: "1" },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(33);
  });

  test("explicit weight 0 ('not important') is not replaced by the default", async () => {
    // Q1 weight 0 → factor 1; Q2 untouched → factor 2 → 1/3 = 33%
    setupTwoQuestions();
    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 0 },
        weights: { [VALID_UUID]: 0 },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(33);
  });

  test("empty candidateIds (no one answered) → same response shape, empty results", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate_answers
    db.query.mockResolvedValueOnce({ rows: [] }); // voter_responses INSERT
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: expect.stringMatching(UUID_RE), questionCount: 1, results: [] });
  });

  test("two candidates → sorted descending by match", async () => {
    const CAND2 = "880e8400-e29b-41d4-a716-446655440000";
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
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
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].answeredCount).toBe(1);
  });

  // Issue #3: the question the candidate skipped must count against the match,
  // and the response must say out of how many questions answeredCount is.
  test("skipped question lowers the match; questionCount is the voter's question total", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] });
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
    expect(res.body.results[0].answeredCount).toBe(1);
    expect(res.body.questionCount).toBe(2);
  });

  test("candidate who answered one question ranks below one who answered all", async () => {
    const CAND2 = "880e8400-e29b-41d4-a716-446655440000";
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] });
    db.query.mockResolvedValueOnce({
      rows: [
        { candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }, // agrees, skipped Q2
        { candidate_id: CAND2, question_id: VALID_UUID, value: 2 },
        { candidate_id: CAND2, question_id: VALID_UUID2, value: 3 }, // diff 1 → 0.75
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [
        { id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" },
        { id: CAND2, name: "B", photo_url: null, bio: null, party_id: "p1", party_name: "P" },
      ],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.id, r.match])).toEqual([
      [CAND2, 88],
      [CANDIDATE_ID, 50],
    ]);
  });

  // Voter answers persist in localStorage across set selections, so the request
  // can carry answers to sets the voter has since deselected. Those must not be
  // scored — with skipped questions now counting as 0, they would drag every
  // candidate down — so the set filter applies to the voter's questions too.
  test("questionSetIds also restrict which of the voter's questions are scored", async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: VALID_UUID, in_selected_sets: true },
        { id: VALID_UUID2, in_selected_sets: false }, // answered earlier, set since deselected
      ],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const SET_ID = "990e8400-e29b-41d4-a716-446655440000";
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 4 }, questionSetIds: [SET_ID] });
    expect(res.status).toBe(200);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/question_set_questions/);
    expect(params).toEqual([[VALID_UUID, VALID_UUID2], [SET_ID]]);
    expect(res.body.results[0].match).toBe(100);
    expect(res.body.questionCount).toBe(1);
  });

  test("every answer in a deselected set → nothing scored, empty results with questionCount 0", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID, in_selected_sets: false }] });
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate answers for an empty question list
    db.query.mockResolvedValueOnce({ rows: [] }); // voter_responses INSERT

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [VALID_UUID2] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: expect.stringMatching(UUID_RE), questionCount: 0, results: [] });
    expect(db.query.mock.calls[1][1]).toEqual([[]]);
    // The voter still answered the question, so it is recorded for research
    // like any other answer outside the selected sets.
    expect(db.query.mock.calls[2][0]).toMatch(/INSERT INTO voter_responses/);
    expect(db.query.mock.calls[2][1].slice(1)).toEqual([VALID_UUID, 2, 1]);
  });

  // The DB hands back lowercase IDs, so an uppercase answer key finds no value
  // and is left out of scoring; it must not inflate the "X/Y" denominator either.
  test("an answer key the scoring can't read is not counted in questionCount", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] });
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2.toUpperCase()]: 4 } });
    expect(res.status).toBe(200);
    expect(res.body.questionCount).toBe(1);
    expect(res.body.results[0]).toMatchObject({ match: 100, answeredCount: 1 });
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe("POST /api/voter/match — response shape", () => {
  test("non-empty result includes sessionId and results array", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
    expect(typeof res.body.sessionId).toBe("string");
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  // Regression: previously returned bare [] when no candidates existed, causing
  // frontend to destructure { results } from an array → undefined → white screen.
  test("empty results has same envelope shape as non-empty results", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate_answers

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(0);
    // Must NOT be a bare array — frontend does `const { results } = body`
    expect(Array.isArray(res.body)).toBe(false);
  });

  test("result items include expected fields", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 3, explanation: "testi" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "Eeva", photo_url: null, bio: "bio", party_id: "p1", party_name: "Puolue" }],
    });
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
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });

    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    expect(insertCall[1][0]).toMatch(UUID_RE); // generated session id leads the params
    expect(insertCall[1]).toContain(VALID_UUID);
    expect(insertCall[1]).toContain(2);
  });

  // The frontend retries the match POST once on a transient upstream error and
  // sends the same sessionId both times, so a retry after a lost response hits
  // the (session_id, question_id) key and stores no second session.
  test("client-supplied sessionId is used for the research insert and returned", async () => {
    const SESSION_ID = "880e8400-e29b-41d4-a716-446655440000";
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses[\s\S]*ON CONFLICT DO NOTHING/);
    expect(insertCall[1][0]).toBe(SESSION_ID);
  });

  test("includeInResearch: false ignores a client-supplied sessionId and stores nothing", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });

    const res = await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2 },
        sessionId: "880e8400-e29b-41d4-a716-446655440000",
        includeInResearch: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test("research row records the default weight 1 for untouched questions and keeps explicit 0", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }, { id: VALID_UUID2 }] });
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/api/voter/match")
      .send({
        answers: { [VALID_UUID]: 2, [VALID_UUID2]: 3 },
        weights: { [VALID_UUID2]: 0 },
      });

    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    // params: [sessionId, q1, value1, weight1, q2, value2, weight2]
    expect(insertCall[1].slice(1)).toEqual([VALID_UUID, 2, 1, VALID_UUID2, 3, 0]);
  });

  // Regression (#24): with no candidate answers yet (early in an election, or
  // a narrow constituency filter) the route returned before the research
  // insert, so these sessions were never recorded and got no sessionId.
  test("voter_responses INSERT still runs when no candidate has answered", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate answers
    db.query.mockResolvedValueOnce({ rows: [] }); // voter_responses INSERT

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, weights: { [VALID_UUID]: 3 }, constituency: "Helsingin vaalipiiri" });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.sessionId).toMatch(UUID_RE);
    // No candidates → no candidate info query; the third call is the insert.
    expect(db.query).toHaveBeenCalledTimes(3);
    const insertCall = db.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    expect(insertCall[1]).toEqual([res.body.sessionId, VALID_UUID, 2, 3]);
  });

  test("no candidates: client-supplied sessionId is used and returned", async () => {
    const SESSION_ID = "990e8400-e29b-41d4-a716-446655440000";
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    expect(db.query.mock.calls[2][1][0]).toBe(SESSION_ID);
  });

  test("no candidates with includeInResearch: false → sessionId null, no INSERT", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, includeInResearch: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: null, questionCount: 1, results: [] });
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

// ─── Stale question IDs (deleted/merged after the voter answered) ─────────────

describe("POST /api/voter/match — stale question IDs", () => {
  // Regression: voter answers live in browser localStorage, so they can reference
  // questions an admin has since merged or deleted. Those used to hit the
  // voter_responses FK and turn the whole match request into a 500.
  test("stale ID is ignored in matching and excluded from the voter_responses INSERT", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // VALID_UUID2 no longer exists
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2, explanation: "" }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2, [VALID_UUID2]: 4 } });
    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(100);
    expect(res.body.results[0].answeredCount).toBe(1);

    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    expect(insertCall[1]).toContain(VALID_UUID);
    expect(insertCall[1]).not.toContain(VALID_UUID2);
  });

  test("all answered questions deleted → 200 with empty results, no INSERT", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // none of the questions exist any more

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: null, questionCount: 0, results: [] });
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

  test("non-UUID sessionId → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, sessionId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/istunnon tunniste/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  test("weights: null counts as no weights", async () => {
    // Scores a candidate and stores research rows, so null reaches weightFor too.
    // Q1: voter=4, cand=2 → similarity 0.5, default weight → 50%
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({
      rows: [{ candidate_id: CANDIDATE_ID, question_id: VALID_UUID, value: 2 }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ id: CANDIDATE_ID, name: "A", photo_url: null, bio: null, party_id: "p1", party_name: "P" }],
    });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 }, weights: null });

    expect(res.status).toBe(200);
    expect(res.body.results[0].match).toBe(50);
    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO voter_responses/);
    expect(insertCall[1].slice(1)).toEqual([VALID_UUID, 4, 1]);
  });

  test.each([
    ["a number", 2],
    ["a string", "2"],
    ["an array", []],
  ])("weights as %s → 400", async (_, weights) => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, weights });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/painoarvot/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  test("invalid UUID in questionSetIds → 400", async () => {
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: ["bad-uuid"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kysymyssarjan tunnisteet/i);
  });

  test("valid questionSetIds → question lookup called with $2 param containing set IDs", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID, in_selected_sets: true }] });
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [VALID_UUID2] });
    expect(res.status).toBe(200);
    // First DB call (index 0) looks up the voter's questions and their set
    // membership; candidate_answers (index 1) gets the already-filtered IDs.
    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(2);
    expect(params[1]).toEqual([VALID_UUID2]);
    expect(db.query.mock.calls[1][1]).toEqual([[VALID_UUID]]);
  });

  test("boundary answer value = 0 → accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 0 } });
    expect(res.status).toBe(200);
  });

  test("boundary answer value = 4 → accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 4 } });
    expect(res.status).toBe(200);
  });

  test("empty candidateIds with questionSetIds filter → still { results: [] } not bare []", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID, in_selected_sets: true }] });
    db.query.mockResolvedValueOnce({ rows: [] }); // no candidate_answers
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [VALID_UUID2] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("results");
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  test("empty questionSetIds array → no filter applied, accepted", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID }] }); // questions that still exist
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/api/voter/match")
      .send({ answers: { [VALID_UUID]: 2 }, questionSetIds: [] });
    expect(res.status).toBe(200);
    // Without filter, candidate_answers call (index 1) has only 1 param (voterQuestionIds)
    const [, params] = db.query.mock.calls[1];
    expect(params).toHaveLength(1);
  });
});
