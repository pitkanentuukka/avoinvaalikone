jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);

const request = require("supertest");
const app = require("../../src/index");

// The Docker healthcheck probes http://localhost:3000/api/health straight at
// the container, without X-Forwarded-Proto. In production the HTTPS redirect
// must not send it to the public site, where another replica would answer
// (issue #10).

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PUBLIC_HOST = process.env.PUBLIC_HOST;

const restore = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(() => {
  process.env.NODE_ENV = "production";
});

afterAll(() => {
  restore("NODE_ENV", ORIGINAL_NODE_ENV);
  restore("PUBLIC_HOST", ORIGINAL_PUBLIC_HOST);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("GET /api/health in production over plain HTTP", () => {
  test("answers from the container instead of redirecting to PUBLIC_HOST", async () => {
    process.env.PUBLIC_HOST = "vaalikone.example.fi";
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("does not log the missing PUBLIC_HOST error on every probe", async () => {
    delete process.env.PUBLIC_HOST;
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(error).not.toHaveBeenCalled();
  });

  test("other routes are still redirected to HTTPS", async () => {
    process.env.PUBLIC_HOST = "vaalikone.example.fi";
    const res = await request(app).get("/api/candidates");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("https://vaalikone.example.fi/api/candidates");
  });
});
