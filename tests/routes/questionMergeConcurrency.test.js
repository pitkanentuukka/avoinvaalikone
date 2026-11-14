// Real PostgreSQL is needed to reproduce snapshot visibility and FK lock waits.
// Run with TEST_DATABASE_URL=postgres://... npm test -- questionMergeConcurrency
// Only a randomly named schema is created; existing application data is untouched.
jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const { randomBytes } = require("crypto");
const { Pool } = require("pg");
const express = require("express");
const request = require("supertest");
const db = require("../../src/db/pool");
const email = require("../../src/email");
const { adminRouter } = require("../../src/routes/questionSets");

const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("question merge concurrent with candidate removal (#53)", () => {
  const schema = `merge_test_${randomBytes(8).toString("hex")}`;
  const app = express();
  app.use(express.json());
  app.use("/api/admin/question-sets", adminRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message, code: err.code }));
  let pool, observer, remover, merger, setId, keepId, dropId, removedId, carriedId, canonicalId;
  let pendingResponse;
  const oldSecret = process.env.ADMIN_SECRET;

  beforeAll(async () => {
    process.env.ADMIN_SECRET = "merge-concurrency-test";
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c statement_timeout=5000`,
      max: 3,
    });
    observer = await pool.connect();
    await observer.query(`CREATE SCHEMA ${schema}`);
    // Minimal route fixture with the production FK and uniqueness constraints.
    await observer.query(`
      CREATE TABLE question_sets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, ngo_name text,
        status text DEFAULT 'pending', hidden boolean DEFAULT true, reviewed_at timestamptz
      );
      CREATE TABLE questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), statement text);
      CREATE TABLE candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE candidate_answers (
        candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
        question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
        value integer, explanation text, answered_at timestamptz DEFAULT now(),
        PRIMARY KEY (candidate_id, question_id)
      );
      CREATE TABLE voter_responses (
        session_id uuid, question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
        value integer, weight integer, PRIMARY KEY (session_id, question_id)
      );
      CREATE TABLE question_set_questions (
        question_set_id uuid REFERENCES question_sets(id) ON DELETE CASCADE,
        question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
        sort_order integer, PRIMARY KEY (question_set_id, question_id)
      );
    `);
    remover = await pool.connect();
    merger = await pool.connect();
    db.getClient.mockResolvedValue({
      query: (...args) => merger.query(...args),
      release: jest.fn(),
    });
    for (const fn of Object.values(email)) {
      if (jest.isMockFunction(fn)) fn.mockResolvedValue();
    }
  });

  beforeEach(async () => {
    await observer.query("TRUNCATE question_sets, questions, candidates CASCADE");
    ({ rows: [{ id: setId }] } = await observer.query("INSERT INTO question_sets DEFAULT VALUES RETURNING id"));
    ({ rows: [{ id: keepId }, { id: dropId }] } = await observer.query(
      "INSERT INTO questions (statement) VALUES ('Canonical'), ('Duplicate') RETURNING id"
    ));
    ({ rows: [{ id: removedId }, { id: carriedId }, { id: canonicalId }] } = await observer.query(
      "INSERT INTO candidates SELECT gen_random_uuid() FROM generate_series(1, 3) RETURNING id"
    ));
    await observer.query(
      "INSERT INTO question_set_questions VALUES ($1, $2, 1), ($1, $3, 2)",
      [setId, keepId, dropId]
    );
    await observer.query(
      `INSERT INTO candidate_answers (candidate_id, question_id, value, explanation)
       VALUES ($1, $4, 1, 'removed'), ($2, $4, 3, 'carried'),
              ($3, $4, 0, 'duplicate'), ($3, $5, 4, 'canonical')`,
      [removedId, carriedId, canonicalId, dropId, keepId]
    );
  });

  afterEach(async () => {
    // Unblock the request even if an assertion fails, before cleaning up.
    await remover.query("ROLLBACK");
    if (pendingResponse) await pendingResponse;
    pendingResponse = undefined;
    await merger.query("ROLLBACK");
  });

  afterAll(async () => {
    remover?.release();
    merger?.release();
    if (observer) {
      await observer.query(`DROP SCHEMA ${schema} CASCADE`);
      observer.release();
    }
    await pool?.end();
    if (oldSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = oldSecret;
  });

  async function waitForCopyBlockedByRemoval() {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { rows: [activity] } = await observer.query(
        `SELECT query, $2 = ANY(pg_blocking_pids(pid)) AS blocked
         FROM pg_stat_activity WHERE pid = $1`,
        [merger.processID, remover.processID]
      );
      if (activity.blocked && /INSERT INTO candidate_answers/.test(activity.query)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Merge copy did not wait for the in-progress candidate removal");
  }

  test.each([
    ["retroactive", "COMMIT"], ["inline", "COMMIT"],
    ["retroactive", "ROLLBACK"], ["inline", "ROLLBACK"],
  ])("%s merge succeeds when candidate removal ends with %s", async (route, outcome) => {
    await remover.query("BEGIN");
    await remover.query("DELETE FROM candidates WHERE id = $1", [removedId]);

    const req = route === "inline"
      ? request(app).patch(`/api/admin/question-sets/${setId}/review`)
        .send({ reviews: [{ questionId: dropId, duplicateOf: keepId }] })
      : request(app).post("/api/admin/question-sets/merge-questions")
        .send({ keepId, dropIds: [dropId] });
    pendingResponse = req.set("Authorization", "Bearer merge-concurrency-test").then((res) => res);
    await waitForCopyBlockedByRemoval();
    await remover.query(outcome);

    const res = await pendingResponse;
    expect({ status: res.status, errorCode: res.body.code }).toEqual({ status: 200, errorCode: undefined });
    const { rows: answers } = await observer.query(
      "SELECT candidate_id, value, explanation FROM candidate_answers WHERE question_id = $1",
      [keepId]
    );
    expect(answers).toEqual(expect.arrayContaining([
      { candidate_id: carriedId, value: 3, explanation: "carried" },
      { candidate_id: canonicalId, value: 4, explanation: "canonical" },
    ]));
    expect(answers).toHaveLength(outcome === "COMMIT" ? 2 : 3);
    if (outcome === "ROLLBACK") {
      expect(answers).toContainEqual({ candidate_id: removedId, value: 1, explanation: "removed" });
    }
    expect((await observer.query("SELECT id FROM questions WHERE id = $1", [dropId])).rows).toEqual([]);
    expect((await observer.query(
      "SELECT question_id FROM question_set_questions WHERE question_set_id = $1", [setId]
    )).rows).toEqual([{ question_id: keepId }]);
  });
});
