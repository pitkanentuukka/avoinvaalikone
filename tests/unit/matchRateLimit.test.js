jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/db/pool");
jest.mock("../../src/email");
jest.mock("../../src/redis", () => null);
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));

const originalLimit = process.env.RATE_LIMIT_MATCH_MAX;
let warn;

beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (originalLimit === undefined) delete process.env.RATE_LIMIT_MATCH_MAX;
  else process.env.RATE_LIMIT_MATCH_MAX = originalLimit;
});

function loadMatchLimit(value) {
  if (value === undefined) delete process.env.RATE_LIMIT_MATCH_MAX;
  else process.env.RATE_LIMIT_MATCH_MAX = value;
  let options;
  jest.isolateModules(() => {
    const rateLimit = require("express-rate-limit");
    rateLimit.mockClear();
    require("../../src/index");
    options = rateLimit.mock.calls.map(([config]) => config)
      .find((config) => config.identifier === "match");
  });
  return options.max;
}

describe("voter match rate-limit startup configuration (#72)", () => {
  test.each([undefined, ""])("%p uses the default without warning", (value) => {
    expect(loadMatchLimit(value)).toBe(300);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["1", "300", "1200", "9007199254740991"])("accepts positive integer %p", (value) => {
    expect(loadMatchLimit(value)).toBe(Number(value));
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    "abc", "0", "-1", "300/min", "1.5", "1e3", "Infinity", "NaN", " ",
    "9007199254740992", "9".repeat(400),
  ])("invalid %p warns and falls back to 300", (value) => {
    expect(loadMatchLimit(value)).toBe(300);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/RATE_LIMIT_MATCH_MAX.*300/));
  });
});
