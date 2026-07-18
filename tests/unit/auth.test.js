jest.mock("../../src/db/pool");

const { requireAdmin, requirePartyToken } = require("../../src/middleware/auth");
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
