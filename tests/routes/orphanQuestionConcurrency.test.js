// READ COMMITTED visibility and row-lock waits require a real PostgreSQL server.
// Fixtures live in a random schema; existing application data is untouched.
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
const { randomBytes } = require("crypto");
const { Pool } = require("pg");
const { adminRouter } = require("../../src/routes/questionSets");
const db = require("../../src/db/pool");
const email = require("../../src/email");
const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function invoke(kind, setId, questionId, body = { reviews: [{ questionId, rejected: true }] }) {
  const path = kind === "merge" ? "/merge-questions" : kind === "set" ? "/:id" : kind === "question" ? "/:id/questions/:questionId" : "/:id/review";
  const method = kind === "merge" ? "post" : kind === "review" ? "patch" : "delete";
  const route = adminRouter.stack.find(l => l.route?.path === path && l.route.methods[method]).route;
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn() };
  const next = jest.fn();
  const done = route.stack.at(-1).handle({
    params: { id: setId, questionId },
    body,
  }, res, next);
  return { done, res, next };
}

describeWithDb("concurrent shared-question unlinks (#92)", () => {
  const schema = `orphan_test_${randomBytes(8).toString("hex")}`;
  let pool, observer, first, second, setIds, questionId, gate, paused, pending;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c statement_timeout=5000`, max: 3 });
    observer = await pool.connect();
    await observer.query(`CREATE SCHEMA ${schema}`);
    await observer.query(`
      CREATE TABLE question_sets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ngo_name text, ngo_email text,
        title text, status text DEFAULT 'approved', hidden boolean DEFAULT true,
        reviewed_at timestamptz
      );
      CREATE TABLE questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), statement text);
      CREATE TABLE question_set_questions (
        question_set_id uuid REFERENCES question_sets(id) ON DELETE CASCADE,
        question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
        sort_order integer, PRIMARY KEY (question_set_id, question_id)
      );
      CREATE TABLE candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE candidate_answers (
        candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
        question_id uuid REFERENCES questions(id) ON DELETE CASCADE, value integer,
        explanation text, answered_at timestamptz DEFAULT now(),
        PRIMARY KEY (candidate_id, question_id)
      );
      CREATE TABLE voter_responses (
        question_id uuid REFERENCES questions(id) ON DELETE CASCADE, value integer,
        session_id uuid, weight integer, PRIMARY KEY (session_id, question_id)
      );
    `);
    first = await pool.connect();
    second = await pool.connect();
    for (const fn of Object.values(email)) if (jest.isMockFunction(fn)) fn.mockResolvedValue();
  });
  beforeEach(async () => {
    pending = [];
    gate = deferred();
    paused = deferred();
    await observer.query("TRUNCATE question_sets, questions, candidates CASCADE");
    setIds = (await observer.query("INSERT INTO question_sets (title) VALUES ('A'), ('B') RETURNING id")).rows.map(r => r.id);
    questionId = (await observer.query("INSERT INTO questions (statement) VALUES ('Shared') RETURNING id")).rows[0].id;
    await observer.query("INSERT INTO question_set_questions VALUES ($1, $3, 1), ($2, $3, 1)", [...setIds, questionId]);
    const candidateId = (await observer.query("INSERT INTO candidates DEFAULT VALUES RETURNING id")).rows[0].id;
    await observer.query("INSERT INTO candidate_answers (candidate_id, question_id, value) VALUES ($1, $2, 2)", [candidateId, questionId]);
    await observer.query("INSERT INTO voter_responses (question_id, value, session_id, weight) VALUES ($1, 2, gen_random_uuid(), 1)", [questionId]);
    db.getClient.mockReset();
    db.getClient.mockResolvedValueOnce({
      query: async (...args) => {
        // Hold the first transaction after its cleanup has checked for orphans.
        if (args[0] === "COMMIT") { paused.resolve(); await gate.promise; }
        return first.query(...args);
      }, release: jest.fn(),
    }).mockResolvedValueOnce({ query: (...args) => second.query(...args), release: jest.fn() });
  });
  afterEach(async () => {
    gate.resolve();
    await Promise.allSettled(pending);
    await first.query("ROLLBACK");
    await second.query("ROLLBACK");
  });
  afterAll(async () => {
    first?.release(); second?.release();
    if (observer) { await observer.query(`DROP SCHEMA ${schema} CASCADE`); observer.release(); }
    await pool?.end();
  });

  test.each([
    ["set", "set"], ["set", "question"], ["set", "review"],
    ["question", "set"], ["question", "question"], ["question", "review"],
    ["review", "set"], ["review", "question"], ["review", "review"],
  ])("%s removal concurrent with %s removal cleans the last orphan", async (kind1, kind2) => {
    const a = invoke(kind1, setIds[0], questionId);
    pending.push(a.done);
    await Promise.race([paused.promise, a.done.then(() => { throw new Error("First removal did not reach COMMIT"); })]);
    const b = invoke(kind2, setIds[1], questionId);
    pending.push(b.done);
    let finished = false;
    b.done.then(() => { finished = true; });
    // The fixed second unlink waits for administrative serialization; otherwise it may finish its
    // orphan check seeing the first transaction's uncommitted link removal.
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (!finished && Date.now() < deadline) {
      const { rows: [r] } = await observer.query(
        "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [second.processID, first.processID]);
      if (r.blocked) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    gate.resolve();
    await Promise.all(pending);
    expect(a.next).not.toHaveBeenCalled();
    expect(b.next).not.toHaveBeenCalled();
    for (const [result, kind] of [[a, kind1], [b, kind2]]) {
      if (kind === "review") expect(result.res.json).toHaveBeenCalled();
      else expect(result.res.status).toHaveBeenCalledWith(204);
    }
    expect((await observer.query("SELECT * FROM question_set_questions")).rows).toEqual([]);
    expect((await observer.query("SELECT * FROM questions")).rows).toEqual([]);
    expect((await observer.query("SELECT * FROM candidate_answers")).rows).toEqual([]);
    expect((await observer.query("SELECT * FROM voter_responses")).rows).toEqual([]);
    expect(blocked).toBe(true);
  });

  test.each(["set", "question"])("%s removal of a shared question does not deadlock with merge FK locks", async (kind) => {
    const keepId = (await observer.query("INSERT INTO questions (statement) VALUES ('Canonical') RETURNING id")).rows[0].id;
    // A production merge locks its canonical/source questions before copying
    // set links. Hold that lock while removal takes its own set lock.
    await second.query("BEGIN");
    await second.query("SELECT id FROM questions WHERE id = ANY($1) ORDER BY id FOR UPDATE", [[questionId, keepId]]);
    db.getClient.mockReset().mockResolvedValue({ query: (...args) => first.query(...args), release: jest.fn() });
    const removal = invoke(kind, setIds[0], questionId);
    pending.push(removal.done);
    let finished = false;
    removal.done.then(() => { finished = true; });
    const deadline = Date.now() + 3000;
    while (!finished && Date.now() < deadline) {
      const { rows: [r] } = await observer.query(
        "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [first.processID, second.processID]);
      if (r.blocked) break;
      await new Promise(r => setTimeout(r, 10));
    }
    // Same FK-taking link copy as mergeQuestions(). A prelock on the shared
    // question causes a cycle: removal waits Q; merge waits removal's set.
    let mergeError;
    try {
      await second.query(`INSERT INTO question_set_questions (question_set_id, question_id, sort_order)
        SELECT question_set_id, $1, sort_order FROM question_set_questions WHERE question_id = $2
        ON CONFLICT (question_set_id, question_id) DO NOTHING`, [keepId, questionId]);
      await second.query("COMMIT");
    } catch (err) { mergeError = err; await second.query("ROLLBACK"); }
    await removal.done;
    expect(mergeError).toBeUndefined();
    expect(removal.next).not.toHaveBeenCalled();
    expect(removal.res.status).toHaveBeenCalledWith(204);
    expect((await observer.query("SELECT id FROM questions WHERE id = $1", [questionId])).rows).toHaveLength(1);
  });


  test.each(["set", "question"])("inline review merge concurrent with %s removal avoids advisory/set lock cycles", async (kind) => {
    const keepId = (await observer.query("INSERT INTO questions (statement) VALUES ('Canonical') RETURNING id")).rows[0].id;
    const copyingLinks = deferred();
    db.getClient.mockReset().mockResolvedValueOnce({
      query: async (...args) => {
        if (/INSERT INTO question_set_questions/.test(args[0])) {
          copyingLinks.resolve(); await gate.promise;
        }
        return first.query(...args);
      }, release: jest.fn(),
    }).mockResolvedValueOnce({ query: (...args) => second.query(...args), release: jest.fn() });
    const merge = invoke("review", setIds[0], questionId, { reviews: [{ questionId, duplicateOf: keepId }] });
    pending.push(merge.done);
    await Promise.race([copyingLinks.promise, merge.done.then(() => { throw new Error("Merge did not reach link copy"); })]);
    const removal = invoke(kind, setIds[1], questionId);
    pending.push(removal.done);
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const { rows: [r] } = await observer.query(
        "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [second.processID, first.processID]);
      if (r.blocked) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    gate.resolve();
    await Promise.all(pending);
    expect(blocked).toBe(true);
    expect(merge.next).not.toHaveBeenCalled();
    expect(removal.next).not.toHaveBeenCalled();
    expect(merge.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    // The merge moved B's link to keepId before removal gets its turn.
    expect(removal.res.status).toHaveBeenCalledWith(kind === "set" ? 204 : 404);
    expect((await observer.query("SELECT id FROM questions WHERE id = $1", [questionId])).rows).toEqual([]);
    expect((await observer.query("SELECT id FROM questions WHERE id = $1", [keepId])).rows).toHaveLength(1);
  });

  test.each(["merge", "review"])("direct merge and review serialize when %s starts first (#146)", async (firstKind) => {
    const keepId = (await observer.query("INSERT INTO questions (statement) VALUES ('Canonical') RETURNING id")).rows[0].id;
    db.getClient.mockReset().mockResolvedValueOnce({
      query: async (...args) => {
        const result = await first.query(...args);
        // Pause after the first route holds its question locks, before merging
        // can copy links and take FK key-share locks on the reviewed set.
        if (/SELECT id FROM questions.*FOR UPDATE/.test(args[0])) {
          paused.resolve(); await gate.promise;
        }
        return result;
      }, release: jest.fn(),
    }).mockResolvedValueOnce({ query: (...args) => second.query(...args), release: jest.fn() });
    const start = kind => invoke(kind, setIds[0], questionId, kind === "merge"
      ? { keepId, dropIds: [questionId] }
      : { reviews: [{ questionId, rejected: false }] });
    const a = start(firstKind);
    pending.push(a.done);
    await Promise.race([paused.promise, a.done.then(() => { throw new Error("First route did not lock questions"); })]);
    const b = start(firstKind === "merge" ? "review" : "merge");
    pending.push(b.done);
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const { rows: [r] } = await observer.query(
        "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [second.processID, first.processID]);
      if (r.blocked) { blocked = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    gate.resolve();
    await Promise.all(pending);
    expect(blocked).toBe(true);
    // next(err) is the route's HTTP 500 path, including PostgreSQL 40P01.
    expect(a.next).not.toHaveBeenCalled();
    expect(b.next).not.toHaveBeenCalled();
    const merge = firstKind === "merge" ? a : b;
    const review = firstKind === "review" ? a : b;
    expect(merge.res.json).toHaveBeenCalledWith(expect.objectContaining({ id: keepId, merged: 1 }));
    if (firstKind === "merge") expect(review.res.status).toHaveBeenCalledWith(404);
    else expect(review.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    expect((await observer.query("SELECT id FROM questions WHERE id = $1", [questionId])).rows).toEqual([]);
    expect((await observer.query("SELECT question_set_id, question_id FROM question_set_questions ORDER BY question_set_id")).rows)
      .toEqual([...setIds].sort().map(id => ({ question_set_id: id, question_id: keepId })));
    expect((await observer.query("SELECT question_id, value FROM candidate_answers")).rows)
      .toEqual([{ question_id: keepId, value: 2 }]);
    expect((await observer.query("SELECT question_id, value FROM voter_responses")).rows)
      .toEqual([{ question_id: keepId, value: 2 }]);
  });
});
