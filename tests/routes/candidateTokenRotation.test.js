// Real PostgreSQL is needed: the route tests mock the database, so only this
// shows that a rotated token really revokes the old link, keeps the profile
// and answers, and stays inside the party (#193).
// Run with TEST_DATABASE_URL=postgres://... npm test -- --runInBand candidateTokenRotation
jest.mock("../../src/db/pool");
jest.mock("../../src/email");

const request = require("supertest");
const db = require("../../src/db/pool");
const { sendCandidateLinkEmail } = require("../../src/email");
const { migrationFiles, createSchema, dropSchema, applyMigrations } = require("../helpers/pgSchema");

const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("candidate token rotation (#193)", () => {
  let ctx, app, partyId, otherPartyId, questionId;
  const ADMIN_SECRET = "token-rotation-test";
  const PARTY_TOKEN = "puolue-" + "a".repeat(32);
  const auth = `Bearer ${ADMIN_SECRET}`;
  const oldSecret = process.env.ADMIN_SECRET;
  const oldSmtp = process.env.SMTP_HOST;
  const q = (sql, params) => ctx.pool.query(sql, params).then((r) => r.rows);

  async function addCandidate(party, name) {
    const [c] = await q(
      `INSERT INTO candidates (party_id, name, email, constituency)
       VALUES ($1, $2, $3, 'Helsingin vaalipiiri') RETURNING id, token`,
      [party, name, `${name.toLowerCase()}@example.fi`]
    );
    await q(
      "INSERT INTO candidate_answers (candidate_id, question_id, value, explanation) VALUES ($1, $2, 3, 'Perustelu')",
      [c.id, questionId]
    );
    return c;
  }

  // The old link is dead, the new one opens the same profile and answers.
  async function expectRotated(oldToken, newToken, name) {
    expect(newToken).toMatch(/^[0-9a-f]{48}$/);
    expect(newToken).not.toBe(oldToken);
    expect((await request(app).get(`/api/candidates/me/${oldToken}`)).status).toBe(404);
    const res = await request(app).get(`/api/candidates/me/${newToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(name);
    expect(res.body.answers[questionId]).toMatchObject({ value: 3, explanation: "Perustelu" });
  }

  beforeAll(async () => {
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.SMTP_HOST = "smtp.example.fi";
    ctx = await createSchema("token_rotation_test");
    await applyMigrations(ctx.pool, migrationFiles());
    app = require("../../src/index");
  });

  beforeEach(async () => {
    await ctx.pool.query("TRUNCATE parties, questions CASCADE");
    [{ id: partyId }, { id: otherPartyId }] = await q(
      "INSERT INTO parties (name, token) VALUES ('Puolue', $1), ('Toinen', 'toinen-x') RETURNING id",
      [PARTY_TOKEN]
    );
    [{ id: questionId }] = await q("INSERT INTO questions (statement) VALUES ('Q1') RETURNING id");
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
    if (oldSmtp === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldSmtp;
  });

  test("admin rotation revokes the old link and keeps profile and answers", async () => {
    const c = await addCandidate(partyId, "Maija");

    const res = await request(app)
      .post(`/api/admin/parties/${partyId}/candidates/${c.id}/token`)
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.emailed).toBe(true);
    await expectRotated(c.token, res.body.token, "Maija");
    expect(sendCandidateLinkEmail.mock.calls[0][0].token).toBe(res.body.token);
  });

  test("admin can't rotate a candidate through another party's id", async () => {
    const c = await addCandidate(partyId, "Maija");
    const res = await request(app)
      .post(`/api/admin/parties/${otherPartyId}/candidates/${c.id}/token`)
      .set("Authorization", auth);
    expect(res.status).toBe(404);
    expect((await q("SELECT token FROM candidates WHERE id = $1", [c.id]))[0].token).toBe(c.token);
  });

  test("party rotation emails the new link, which works; the old one doesn't", async () => {
    const c = await addCandidate(partyId, "Maija");

    const res = await request(app).post(`/api/candidates/party/${PARTY_TOKEN}/candidates/${c.id}/token`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{48}/);
    const emailed = sendCandidateLinkEmail.mock.calls[0][0].token;
    await expectRotated(c.token, emailed, "Maija");
  });

  test("a party token can't rotate another party's candidate", async () => {
    const other = await addCandidate(otherPartyId, "Liisa");
    const res = await request(app).post(`/api/candidates/party/${PARTY_TOKEN}/candidates/${other.id}/token`);
    expect(res.status).toBe(404);
    expect((await q("SELECT token FROM candidates WHERE id = $1", [other.id]))[0].token).toBe(other.token);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  // Whoever holds the leaked link may have changed the address to their own.
  test("an address changed since the secretary saw it is refused; the old link isn't rotated", async () => {
    const c = await addCandidate(partyId, "Maija");
    await request(app)
      .put(`/api/candidates/me/${c.token}`)
      .send({ name: "Maija", email: "hyokkaaja@example.com", constituency: "Helsingin vaalipiiri" })
      .expect(200);

    for (const res of [
      await request(app).post(`/api/candidates/party/${PARTY_TOKEN}/candidates/${c.id}/token`).send({ expectedEmail: "maija@example.fi" }),
      await request(app).post(`/api/admin/parties/${partyId}/candidates/${c.id}/token`).set("Authorization", auth).send({ expectedEmail: "maija@example.fi" }),
    ]) {
      expect(res.status).toBe(409);
    }
    expect((await q("SELECT token FROM candidates WHERE id = $1", [c.id]))[0].token).toBe(c.token);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("a matching expectedEmail (any case, spaces) rotates through both routes", async () => {
    const c = await addCandidate(partyId, "Maija");
    const admin = await request(app)
      .post(`/api/admin/parties/${partyId}/candidates/${c.id}/token`)
      .set("Authorization", auth)
      .send({ expectedEmail: " Maija@Example.FI " });
    expect(admin.status).toBe(200);
    await expectRotated(c.token, admin.body.token, "Maija");

    const party = await request(app)
      .post(`/api/candidates/party/${PARTY_TOKEN}/candidates/${c.id}/token`)
      .send({ expectedEmail: " Maija@Example.FI " });
    expect(party.status).toBe(200);
    await expectRotated(admin.body.token, sendCandidateLinkEmail.mock.calls.at(-1)[0].token, "Maija");
  });

  // After the route's own SELECT: the UPDATE itself must compare the address.
  test("party route: address changed just before the UPDATE → 409, nothing rotated", async () => {
    const c = await addCandidate(partyId, "Maija");
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE candidates SET token = DEFAULT/.test(sql)) {
        await ctx.pool.query("UPDATE candidates SET email = 'hyokkaaja@example.com' WHERE id = $1", [c.id]);
      }
      return ctx.pool.query(sql, params);
    });

    const res = await request(app)
      .post(`/api/candidates/party/${PARTY_TOKEN}/candidates/${c.id}/token`)
      .send({ expectedEmail: "maija@example.fi" });

    expect(res.status).toBe(409);
    expect((await q("SELECT token FROM candidates WHERE id = $1", [c.id]))[0].token).toBe(c.token);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  test("admin route: an address set on a candidate shown without one is refused", async () => {
    const [c] = await q(
      `INSERT INTO candidates (party_id, name, constituency) VALUES ($1, 'Vanha', 'Helsingin vaalipiiri')
       RETURNING id, token`,
      [partyId]
    );
    await request(app)
      .put(`/api/candidates/me/${c.token}`)
      .send({ name: "Vanha", email: "hyokkaaja@example.com", constituency: "Helsingin vaalipiiri" })
      .expect(200);

    const res = await request(app)
      .post(`/api/admin/parties/${partyId}/candidates/${c.id}/token`)
      .set("Authorization", auth)
      .send({ expectedEmail: "" });

    expect(res.status).toBe(409);
    expect((await q("SELECT token FROM candidates WHERE id = $1", [c.id]))[0].token).toBe(c.token);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });

  // A profile save that passed the token lookup just before the rotation
  // must not land after it.
  test.each([
    ["PUT /me", (token) => request(app).put(`/api/candidates/me/${token}`)
      .send({ name: "Maija", email: "hyokkaaja@example.com", constituency: "Helsingin vaalipiiri" })],
    ["PUT /me/answers", (token) => request(app).put(`/api/candidates/me/${token}/answers`)
      .send({ answers: { [questionId]: { value: 0, explanation: "Muutettu" } } })],
  ])("%s with the old link, rotated after its token lookup → 404, nothing written", async (_, send) => {
    const c = await addCandidate(partyId, "Maija");
    let rotated = false;
    const rotateFirst = async () => {
      if (!rotated) {
        rotated = true;
        await ctx.pool.query("UPDATE candidates SET token = DEFAULT WHERE id = $1", [c.id]);
      }
    };
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE candidates\s+SET name/.test(sql)) await rotateFirst();
      return ctx.pool.query(sql, params);
    });
    // A wrapper, not a patched client: the real one goes back to the pool on
    // release, and a patched query there would hang the next pool.query.
    db.getClient.mockImplementation(async () => {
      const client = await ctx.pool.connect();
      return {
        query: async (sql, params) => {
          if (/UPDATE candidates SET updated_at/.test(sql)) await rotateFirst();
          return client.query(sql, params);
        },
        release: (err) => client.release(err),
      };
    });

    const res = await send(c.token);

    expect(rotated).toBe(true);
    expect(res.status).toBe(404);
    const [row] = await q("SELECT email FROM candidates WHERE id = $1", [c.id]);
    expect(row.email).toBe("maija@example.fi");
    const [answer] = await q("SELECT value FROM candidate_answers WHERE candidate_id = $1", [c.id]);
    expect(answer.value).toBe(3);
  });

  test("bulk rotation changes every link in the party and none elsewhere", async () => {
    const a = await addCandidate(partyId, "Maija");
    const b = await addCandidate(partyId, "Matti");
    const other = await addCandidate(otherPartyId, "Liisa");

    const res = await request(app)
      .post(`/api/admin/parties/${partyId}/candidate-tokens`)
      .set("Authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rotated: 2 });
    const tokens = Object.fromEntries(
      (await q("SELECT name, token FROM candidates")).map((r) => [r.name, r.token])
    );
    await expectRotated(a.token, tokens.Maija, "Maija");
    await expectRotated(b.token, tokens.Matti, "Matti");
    expect(tokens.Maija).not.toBe(tokens.Matti);
    expect(tokens.Liisa).toBe(other.token);
    expect(sendCandidateLinkEmail).not.toHaveBeenCalled();
  });
});
