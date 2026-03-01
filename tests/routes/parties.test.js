jest.mock("../../src/db/pool");

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");

const ADMIN_SECRET = "test-admin-secret";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const authHeader = `Bearer ${ADMIN_SECRET}`;

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

beforeEach(() => {
  db.query.mockReset();
});

// ─── Auth checks ──────────────────────────────────────────────────────────────

describe("Admin auth on party routes", () => {
  test("GET / without auth → 401", async () => {
    const res = await request(app).get("/api/admin/parties");
    expect(res.status).toBe(401);
  });

  test("GET / with wrong token → 403", async () => {
    const res = await request(app)
      .get("/api/admin/parties")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(403);
  });
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe("GET /api/admin/parties", () => {
  test("happy path → 200 with party array", async () => {
    const parties = [{ id: VALID_UUID, name: "Testi", token: "abc", email: null, created_at: new Date().toISOString() }];
    db.query.mockResolvedValueOnce({ rows: parties });

    const res = await request(app)
      .get("/api/admin/parties")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(parties);
  });
});

// ─── POST / ───────────────────────────────────────────────────────────────────

describe("POST /api/admin/parties", () => {
  test("missing name → 400", async () => {
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nimi vaaditaan/i);
  });

  test("name too long (>100 chars) → 400", async () => {
    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "a".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/liian pitkä/i);
  });

  test("happy path → 201 with new party including token", async () => {
    const party = {
      id: VALID_UUID,
      name: "Vihreät",
      token: "vihre-t-abc12345",
      email: null,
      created_at: new Date().toISOString(),
    };
    db.query.mockResolvedValueOnce({ rows: [party] });

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Vihreät", token: expect.any(String) });
  });

  test("duplicate name → 409", async () => {
    const err = new Error("duplicate");
    err.code = "23505";
    db.query.mockRejectedValueOnce(err);

    const res = await request(app)
      .post("/api/admin/parties")
      .set("Authorization", authHeader)
      .send({ name: "Vihreät" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/jo olemassa/i);
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

describe("DELETE /api/admin/parties/:id", () => {
  test("invalid UUID param → 400", async () => {
    const res = await request(app)
      .delete("/api/admin/parties/not-a-uuid")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });

  test("not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete(`/api/admin/parties/${VALID_UUID}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ei löytynyt/i);
  });

  test("happy path → 200 { deleted: true }", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete(`/api/admin/parties/${VALID_UUID}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });
});
