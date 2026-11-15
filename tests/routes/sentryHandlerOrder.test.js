jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);
jest.mock("../../src/instrument", () => ({
  setupExpressErrorHandler: jest.fn((app) => {
    // The SDK registers a normal request handler as well as an error handler.
    app.use(mockRequestHandler);
    app.use((err, req, res, next) => next(err));
  }),
}));

const request = require("supertest");
const mockRequestHandler = jest.fn((req, res, next) => next());
const originalDsn = process.env.SENTRY_DSN;

afterEach(() => {
  if (originalDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalDsn;
  jest.clearAllMocks();
});

test.each([true, false])("unknown routes return Finnish 404 JSON with Sentry enabled=%s", async (enabled) => {
  process.env.SENTRY_DSN = enabled ? "http://public@127.0.0.1:1/1" : "";
  let app;
  jest.isolateModules(() => {
    app = require("../../src/index");
  });

  const res = await request(app).get("/api/nonexistent-route");

  expect(res.status).toBe(404);
  expect(res.headers["content-type"]).toMatch(/application\/json/);
  expect(res.body).toEqual({ error: "Reittiä ei löytynyt" });
  // A terminal 404 handler placed before Sentry makes this unreachable (#84).
  expect(mockRequestHandler).toHaveBeenCalledTimes(enabled ? 1 : 0);
});
