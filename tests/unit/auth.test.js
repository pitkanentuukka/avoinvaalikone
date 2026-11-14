jest.mock("../../src/db/pool");

const {
  requireAdmin, requirePartyToken, requireCandidateToken, requireRegistrationToken,
} = require("../../src/middleware/auth");
const db = require("../../src/db/pool");

const ADMIN_SECRET = "test-admin-secret";

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
});

const makeReqRes = (overrides = {}) => {
  const req = { headers: {}, params: {}, ...overrides };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const next = jest.fn();
  return { req, res, next };
};

describe.each([
  ["partyToken", requirePartyToken, "party", "Virheellinen puoluetunniste"],
  ["candidateToken", requireCandidateToken, "candidate", "Virheellinen ehdokastunniste"],
  ["registrationToken", requireRegistrationToken, "party", "Virheellinen rekisteröitymislinkki"],
])("%s validation", (param, middleware, attachedField, invalidMessage) => {
  const validToken = "0123456789abcdef".repeat(3);

  beforeEach(() => db.query.mockReset());

  test.each([
    ["only NUL", "\0"],
    ["leading NUL", `\0${validToken}`],
    ["embedded NUL", `${validToken.slice(0, 24)}\0${validToken.slice(24)}`],
    ["trailing NUL", `${validToken}\0`],
  ])("%s → invalid-link 404 without querying PostgreSQL", async (_label, token) => {
    // Model pg rejecting a text parameter containing NUL, as it does in production.
    const pgError = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: "22021",
    });
    db.query.mockRejectedValue(pgError);
    const { req, res, next } = makeReqRes({ params: { [param]: token } });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: invalidMessage });
    expect(db.query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(req[attachedField]).toBeUndefined();
  });

  test("valid token → looks up and attaches the authenticated record", async () => {
    const record = { id: "record-id", name: "Testi" };
    db.query.mockResolvedValueOnce({ rows: [record] });
    const { req, res, next } = makeReqRes({ params: { [param]: validToken } });

    await middleware(req, res, next);

    expect(db.query).toHaveBeenCalledWith(expect.any(String), [validToken]);
    expect(req[attachedField]).toBe(record);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("unknown token → invalid-link 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const { req, res, next } = makeReqRes({ params: { [param]: validToken } });

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: invalidMessage });
    expect(next).not.toHaveBeenCalled();
  });

  test("database failure for a valid token → next(err)", async () => {
    const err = new Error("DB down");
    db.query.mockRejectedValueOnce(err);
    const { req, res, next } = makeReqRes({ params: { [param]: validToken } });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── requireAdmin ─────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  test("no Authorization header → 401", () => {
    const { req, res, next } = makeReqRes();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("wrong scheme (no 'Bearer ') → 401", () => {
    const { req, res, next } = makeReqRes({
      headers: { authorization: "Basic abc" },
    });
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("wrong token → 403", () => {
    const { req, res, next } = makeReqRes({
      headers: { authorization: "Bearer wrong-secret" },
    });
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("correct token → calls next()", () => {
    const { req, res, next } = makeReqRes({
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("different-length token → 403 (timing-safe path)", () => {
    const { req, res, next } = makeReqRes({
      headers: { authorization: "Bearer short" },
    });
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── requirePartyToken ────────────────────────────────────────────────────────

describe("requirePartyToken", () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  test("missing partyToken param → 400", async () => {
    const { req, res, next } = makeReqRes({ params: {} });
    await requirePartyToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test("token found → sets req.party and calls next()", async () => {
    const party = { id: "pid-1", name: "Testi", token: "abc-123", email: null };
    db.query.mockResolvedValueOnce({ rows: [party] });

    const { req, res, next } = makeReqRes({
      params: { partyToken: "abc-123" },
    });
    await requirePartyToken(req, res, next);

    expect(req.party).toEqual(party);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("token not found → 404", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const { req, res, next } = makeReqRes({
      params: { partyToken: "no-such-token" },
    });
    await requirePartyToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  test("DB throws → calls next(err)", async () => {
    const err = new Error("DB down");
    db.query.mockRejectedValueOnce(err);

    const { req, res, next } = makeReqRes({
      params: { partyToken: "abc-123" },
    });
    await requirePartyToken(req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
