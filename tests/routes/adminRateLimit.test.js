jest.mock("../../src/db/pool");
jest.mock("../../src/email");
// Keep the in-memory store even if REDIS_URL is set (tests/setupEnv.js blanks
// it): Redis counters would survive between runs and fail open when Redis is
// down.
jest.mock("../../src/redis", () => null);

const request = require("supertest");
const app = require("../../src/index");
const db = require("../../src/db/pool");

// The admin limiter lives in the src/index.js wiring and is skipped outside
// production, so these tests run the whole app in production mode.
// x-forwarded-proto keeps the HTTPS redirect out of the way.

const ADMIN_SECRET = "test-admin-secret";
const ADMIN_LIMIT = 30;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let ipCounter = 0;

// Each test gets its own client IP, so its rate-limit bucket starts empty.
const client = () => {
  ipCounter += 1;
  const ip = `203.0.113.${ipCounter}`;
  return (method, path) =>
    request(app)[method](path)
      .set("X-Forwarded-For", ip)
      .set("X-Forwarded-Proto", "https");
};

beforeAll(() => {
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  process.env.NODE_ENV = "production";
});

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

describe("Admin rate limit", () => {
  test("authenticated admin requests are not throttled", async () => {
    const req = client();
    for (let i = 0; i < ADMIN_LIMIT + 10; i++) {
      const path = i % 2 ? "/api/admin/parties" : "/api/admin/question-sets";
      const res = await req("get", path).set("Authorization", `Bearer ${ADMIN_SECRET}`);
      expect(res.status).toBe(200);
    }
  });

  test("requests with a wrong secret are throttled after the limit", async () => {
    const req = client();
    for (let i = 0; i < ADMIN_LIMIT; i++) {
      const res = await req("get", "/api/admin/parties").set("Authorization", "Bearer wrong");
      expect(res.status).toBe(403);
    }
    const res = await req("get", "/api/admin/parties").set("Authorization", "Bearer wrong");
    expect(res.status).toBe(429);
  });

  test("requests without a secret count toward the limit too", async () => {
    const req = client();
    for (let i = 0; i < ADMIN_LIMIT; i++) {
      const res = await req("get", "/api/admin/question-sets");
      expect(res.status).toBe(401);
    }
    const res = await req("get", "/api/admin/question-sets");
    expect(res.status).toBe(429);
  });

  test("the real admin still gets in after failed guesses used up the budget", async () => {
    const req = client();
    for (let i = 0; i < ADMIN_LIMIT; i++) {
      await req("get", "/api/admin/parties").set("Authorization", "Bearer wrong");
    }
    const blocked = await req("get", "/api/admin/parties").set("Authorization", "Bearer wrong");
    expect(blocked.status).toBe(429);

    const res = await req("get", "/api/admin/parties").set("Authorization", `Bearer ${ADMIN_SECRET}`);
    expect(res.status).toBe(200);
  });
});
