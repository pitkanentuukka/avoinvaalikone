// Real PostgreSQL is needed: only the database can stop two registrations
// that both passed the duplicate check from inserting (#151).
// Run with TEST_DATABASE_URL=postgres://... npm test -- --runInBand candidateRegistrationConcurrency
// The real migrations are applied into randomly named schemas, which are
// dropped afterwards; existing application data is untouched.
jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail } = require("../../src/email");

const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const { migrationFiles, createSchema, dropSchema, applyMigrations } = require("../helpers/pgSchema");

describeWithDb("migration reconciles duplicate registrations (#151)", () => {
  let ctx;
  const pending = migrationFiles().filter((f) => f >= "015");

  beforeAll(async () => {
    ctx = await createSchema("reg_migration_test");
    await applyMigrations(ctx.pool, migrationFiles().filter((f) => f < "015"));
  });

  afterAll(async () => {
    if (ctx) await dropSchema(ctx);
  });

  test("keeps one candidate per party/name/email, preferring the one with answers, and carries the rest over", async () => {
    const q = (sql, params) => ctx.pool.query(sql, params).then((r) => r.rows);
    const [{ id: partyId }, { id: otherPartyId }] = await q(
      "INSERT INTO parties (name, token) VALUES ('Puolue', 'p1'), ('Toinen', 'p2') RETURNING id"
    );
    const [{ id: setId }] = await q("INSERT INTO question_sets (ngo_name, title) VALUES ('NGO', 'Setti') RETURNING id");
    const [{ id: q1 }, { id: q2 }, { id: q3 }, { id: q4 }] = await q(
      "INSERT INTO questions (statement) VALUES ('Q1'), ('Q2'), ('Q3'), ('Q4') RETURNING id"
    );
    await q(
      `INSERT INTO question_set_questions (question_set_id, question_id, sort_order)
       VALUES ($1, $2, 1), ($1, $3, 2), ($1, $4, 3), ($1, $5, 4)`,
      [setId, q1, q2, q3, q4]
    );
    const insertCandidate = (party, name, email, createdAt) =>
      q(
        `INSERT INTO candidates (party_id, name, email, constituency, created_at, updated_at)
         VALUES ($1, $2, $3, 'Helsingin vaalipiiri', $4, $4) RETURNING id`,
        [party, name, email, createdAt]
      ).then(([row]) => row.id);

    // Three sign-ups of one person: the oldest is unused, the middle one has
    // most answers, the newest answered a question the middle one didn't.
    const unused = await insertCandidate(partyId, "Eeva Ehdokas", "eeva@example.fi", "2026-01-01");
    const keep = await insertCandidate(partyId, "eeva ehdokas", "EEVA@example.fi", "2026-01-02");
    const extra = await insertCandidate(partyId, " Eeva Ehdokas ", "eeva@example.fi ", "2026-01-03");
    // Not duplicates: other party, other name, other address, no address.
    const otherParty = await insertCandidate(otherPartyId, "Eeva Ehdokas", "eeva@example.fi", "2026-01-01");
    const otherName = await insertCandidate(partyId, "Eeva Toinen", "eeva@example.fi", "2026-01-01");
    const otherEmail = await insertCandidate(partyId, "Eeva Ehdokas", "toimisto@example.fi", "2026-01-01");
    const noEmail1 = await insertCandidate(partyId, "Ville Vanha", null, "2026-01-01");
    const noEmail2 = await insertCandidate(partyId, "Ville Vanha", null, "2026-01-02");

    await q(
      `INSERT INTO candidate_answers (candidate_id, question_id, value, explanation, answered_at) VALUES
         ($1, $3, 4, 'keep q1', '2026-02-01'), ($1, $4, 3, 'keep q2', '2026-02-01'),
         ($1, $6, 2, 'keep q4', '2026-02-01'),
         ($2, $3, 0, 'extra q1', '2026-03-01'), ($2, $5, 1, 'extra q3', '2026-03-01')`,
      [keep, extra, q1, q2, q3, q4]
    );
    await q("INSERT INTO email_log (kind, recipient, candidate_id, status) VALUES ('candidate_link', 'eeva@example.fi', $1, 'sent')", [unused]);

    expect(pending.length).toBeGreaterThan(0); // the reconciling migration exists
    await applyMigrations(ctx.pool, pending);

    const ids = (await q("SELECT id FROM candidates")).map((r) => r.id).sort();
    expect(ids).toEqual([keep, otherParty, otherName, otherEmail, noEmail1, noEmail2].sort());

    // The kept candidate's own answers win; the duplicate's answer to a
    // question it never answered is carried over.
    const answers = await q(
      "SELECT question_id, value, explanation FROM candidate_answers WHERE candidate_id = $1 ORDER BY explanation",
      [keep]
    );
    expect(answers).toEqual([
      { question_id: q3, value: 1, explanation: "extra q3" },
      { question_id: q1, value: 4, explanation: "keep q1" },
      { question_id: q2, value: 3, explanation: "keep q2" },
      { question_id: q4, value: 2, explanation: "keep q4" },
    ]);
    expect(await q("SELECT 1 FROM email_log WHERE candidate_id = $1", [unused])).toEqual([]);

    // From now on the database refuses another copy of the identity.
    await expect(insertCandidate(partyId, "EEVA EHDOKAS", "Eeva@Example.fi", "2026-04-01")).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describeWithDb("concurrent candidate registrations (#151)", () => {
  let ctx, app, partyId;
  const REGISTRATION_TOKEN = "f".repeat(48);
  const PROFILE = { name: "Eeva Ehdokas", email: "eeva@example.fi", constituency: "Helsingin vaalipiiri" };
  const oldSecret = process.env.ADMIN_SECRET;

  beforeAll(async () => {
    process.env.ADMIN_SECRET = "registration-concurrency-test";
    ctx = await createSchema("reg_concurrency_test");
    await applyMigrations(ctx.pool, migrationFiles());
    app = require("../../src/index");
  });

  beforeEach(async () => {
    await ctx.pool.query("TRUNCATE parties CASCADE");
    ({ rows: [{ id: partyId }] } = await ctx.pool.query(
      "INSERT INTO parties (name, token, registration_token) VALUES ('Puolue', 'p1', $1) RETURNING id",
      [REGISTRATION_TOKEN]
    ));
    db.query.mockReset();
    db.query.mockImplementation((...args) => ctx.pool.query(...args));
    db.getClient.mockReset();
    db.getClient.mockImplementation(() => ctx.pool.connect());
    sendCandidateLinkEmail.mockReset();
    sendCandidateLinkEmail.mockResolvedValue();
  });

  afterAll(async () => {
    if (ctx) await dropSchema(ctx);
    if (oldSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = oldSecret;
  });

  // Hold every INSERT INTO candidates until `count` of them are waiting, so
  // each request has finished its duplicate check before any row exists.
  function barrierBeforeCandidateInsert(count) {
    let waiting = [];
    const timeoutMs = 3000;
    db.query.mockImplementation(async (sql, params) => {
      if (/^\s*INSERT INTO candidates\b/.test(sql)) {
        await new Promise((resolve, reject) => {
          waiting.push(resolve);
          if (waiting.length === count) waiting.forEach((release) => release());
          setTimeout(() => reject(new Error("only some registrations reached the INSERT")), timeoutMs).unref();
        });
      }
      return ctx.pool.query(sql, params);
    });
  }

  test("two overlapping registrations of the same person create one candidate; the other gets the recovery response", async () => {
    barrierBeforeCandidateInsert(2);
    const url = `/api/candidates/register/${REGISTRATION_TOKEN}`;
    const responses = await Promise.all([
      request(app).post(url).send(PROFILE),
      request(app).post(url).send({ ...PROFILE, name: " eeva EHDOKAS ", email: "Eeva@Example.fi" }),
    ]);

    const { rows } = await ctx.pool.query("SELECT id, name, email, token FROM candidates WHERE party_id = $1", [partyId]);
    expect(rows).toHaveLength(1);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);

    const created = responses.find((r) => r.status === 201);
    const recovered = responses.find((r) => r.status === 409);
    expect(created.body.token).toBe(rows[0].token);
    // The competing request must not hand out the existing bearer token.
    expect(JSON.stringify(recovered.body)).not.toContain(rows[0].token);
    expect(recovered.body.error).toMatch(/lähetimme/i);
    expect(sendCandidateLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: rows[0].id, token: rows[0].token }),
      "Puolue",
      expect.any(String)
    );
  });

  test("a profile update cannot take another candidate's name and address in the same party", async () => {
    const { rows: [, other] } = await ctx.pool.query(
      `INSERT INTO candidates (party_id, name, email, constituency) VALUES
         ($1, 'Eeva Ehdokas', 'toimisto@example.fi', 'Helsingin vaalipiiri'),
         ($1, 'Ville Ehdokas', 'toimisto@example.fi', 'Helsingin vaalipiiri')
       RETURNING id, token`,
      [partyId]
    );
    const takeOver = { ...PROFILE, name: "EEVA ehdokas", email: "Toimisto@example.fi" };

    for (const body of [takeOver, { ...takeOver, answers: {} }]) {
      const res = await request(app).put(`/api/candidates/me/${other.token}`).send(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/jo ehdokas/i);
    }
    const { rows } = await ctx.pool.query("SELECT name FROM candidates WHERE id = $1", [other.id]);
    expect(rows[0].name).toBe("Ville Ehdokas");
  });
});
