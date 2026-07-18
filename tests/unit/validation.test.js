const {
  isValidUUID,
  isValidLength,
  isValidRange,
  isValidUrl,
  isValidEmail,
  validateUUIDArray,
  validateUUIDParam,
  validateBodyField,
} = require("../../src/middleware/validation");

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

// ─── isValidUUID ───────────────────────────────────────────────────────────────

describe("isValidUUID", () => {
  test("valid lowercase UUID returns true", () => {
    expect(isValidUUID(VALID_UUID)).toBe(true);
  });

  test("valid uppercase UUID returns true", () => {
    expect(isValidUUID(VALID_UUID.toUpperCase())).toBe(true);
  });

  test("empty string returns false", () => {
    expect(isValidUUID("")).toBe(false);
  });

  test("null returns false", () => {
    expect(isValidUUID(null)).toBe(false);
  });

  test("number returns false", () => {
    expect(isValidUUID(123)).toBe(false);
  });

  test("truncated UUID returns false", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716")).toBe(false);
  });

  test("UUID with extra characters returns false", () => {
    expect(isValidUUID(VALID_UUID + "x")).toBe(false);
  });
});

// ─── isValidLength ─────────────────────────────────────────────────────────────

describe("isValidLength", () => {
  test("string at maxLength boundary returns true", () => {
    expect(isValidLength("a".repeat(500), 500)).toBe(true);
  });

  test("string one over maxLength returns false", () => {
    expect(isValidLength("a".repeat(501), 500)).toBe(false);
  });

  test("empty string returns false", () => {
    expect(isValidLength("", 500)).toBe(false);
  });

  test("null returns false", () => {
    expect(isValidLength(null, 500)).toBe(false);
  });

  test("custom maxLength of 10 respected", () => {
    expect(isValidLength("hello", 10)).toBe(true);
    expect(isValidLength("hello world!", 10)).toBe(false);
  });
});

// ─── isValidRange ──────────────────────────────────────────────────────────────

describe("isValidRange", () => {
  test("value at lower boundary (0) returns true", () => {
    expect(isValidRange(0, 0, 4)).toBe(true);
  });

  test("value at upper boundary (4) returns true", () => {
    expect(isValidRange(4, 0, 4)).toBe(true);
  });

  test("value below lower boundary returns false", () => {
    expect(isValidRange(-1, 0, 4)).toBe(false);
  });

  test("value above upper boundary returns false", () => {
    expect(isValidRange(5, 0, 4)).toBe(false);
  });

  test("numeric string is coerced and accepted", () => {
    expect(isValidRange("3", 0, 4)).toBe(true);
  });

  test("NaN returns false", () => {
    expect(isValidRange(NaN, 0, 4)).toBe(false);
  });

  test("non-numeric string returns false", () => {
    expect(isValidRange("abc", 0, 4)).toBe(false);
  });
});

// ─── isValidUrl ───────────────────────────────────────────────────────────────

describe("isValidUrl", () => {
  test("https:// URL returns true", () => {
    expect(isValidUrl("https://example.com/logo.png")).toBe(true);
  });

  test("http:// URL returns true", () => {
    expect(isValidUrl("http://example.com/logo.png")).toBe(true);
  });

  test("javascript: scheme returns false", () => {
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
  });

  test("data: URI returns false", () => {
    expect(isValidUrl("data:text/html,<h1>xss</h1>")).toBe(false);
  });

  test("bare domain (no scheme) returns false", () => {
    expect(isValidUrl("example.com")).toBe(false);
  });

  test("null returns false", () => {
    expect(isValidUrl(null)).toBe(false);
  });
});

// ─── isValidEmail ─────────────────────────────────────────────────────────────

describe("isValidEmail", () => {
  test("valid email returns true", () => {
    expect(isValidEmail("info@example.fi")).toBe(true);
  });

  test("missing @ returns false", () => {
    expect(isValidEmail("notanemail.com")).toBe(false);
  });

  test("missing domain returns false", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  test("null returns false", () => {
    expect(isValidEmail(null)).toBe(false);
  });
});

// ─── validateUUIDArray ────────────────────────────────────────────────────────

describe("validateUUIDArray", () => {
  test("null returns false", () => {
    expect(validateUUIDArray(null)).toBe(false);
  });

  test("non-array returns false", () => {
    expect(validateUUIDArray("not-an-array")).toBe(false);
  });

  test("array with all valid UUIDs returns true", () => {
    expect(validateUUIDArray([VALID_UUID, VALID_UUID])).toBe(true);
  });

  test("array with one invalid UUID returns false", () => {
    expect(validateUUIDArray([VALID_UUID, "not-a-uuid"])).toBe(false);
  });

  test("empty array returns true (vacuous-true)", () => {
    expect(validateUUIDArray([])).toBe(true);
  });
});

// ─── validateUUIDParam middleware ─────────────────────────────────────────────

describe("validateUUIDParam middleware", () => {
  const makeReqRes = (paramValue) => {
    const req = { params: { id: paramValue } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return { req, res, next };
  };

  test("valid UUID calls next()", () => {
    const { req, res, next } = makeReqRes(VALID_UUID);
    validateUUIDParam("id")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("invalid UUID returns 400 with Finnish error message", () => {
    const { req, res, next } = makeReqRes("not-a-uuid");
    validateUUIDParam("id")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Virheellinen") })
    );
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── validateBodyField middleware ─────────────────────────────────────────────

describe("validateBodyField middleware", () => {
  const makeReqRes = (body) => {
    const req = { body };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    return { req, res, next };
  };

  test("required field missing returns 400", () => {
    const { req, res, next } = makeReqRes({});
    validateBodyField("name", 100, true)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test("field too long returns 400", () => {
    const { req, res, next } = makeReqRes({ name: "a".repeat(101) });
    validateBodyField("name", 100, true)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test("optional field missing calls next()", () => {
    const { req, res, next } = makeReqRes({});
    validateBodyField("bio", 500, false)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("valid required field calls next()", () => {
    const { req, res, next } = makeReqRes({ name: "Kansallinen Koalitio" });
    validateBodyField("name", 100, true)(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
