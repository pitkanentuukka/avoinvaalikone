// The frontend is an ES module package, so it is loaded with import() (npm test
// runs Jest with --experimental-vm-modules for this).
let createApi, isTransientError;
beforeAll(async () => {
  ({ createApi, isTransientError } = await import("../../vaalikone-frontend/src/api.js"));
});

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/** An api whose fetch returns the given outcomes in order (an Error is thrown). */
function apiWith(...outcomes) {
  const fetch = jest.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { api: createApi({ base: "/api", fetch, retryDelayMs: 0 }), fetch };
}

const networkError = () => new TypeError("Failed to fetch");

describe("apiFetch retries", () => {
  test("GET is retried once on a transient upstream error", async () => {
    const { api, fetch } = apiWith(jsonResponse(503, {}), jsonResponse(200, [{ ngo_name: "X" }]));
    await expect(api.getQuestionSets()).resolves.toEqual([{ ngoName: "X" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("GET is retried once on a network error", async () => {
    const { api, fetch } = apiWith(networkError(), jsonResponse(200, []));
    await expect(api.getCandidates()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("GET makes at most two attempts when the retry also fails with a network error", async () => {
    const { api, fetch } = apiWith(networkError(), networkError(), jsonResponse(200, []));
    await expect(api.getCandidates()).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("GET makes at most two attempts when the first fails with a status and the retry with a network error", async () => {
    const { api, fetch } = apiWith(jsonResponse(504, {}), networkError(), jsonResponse(200, []));
    await expect(api.getCandidates()).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("a non-transient error is not retried", async () => {
    const { api, fetch } = apiWith(jsonResponse(500, { error: "Palvelinvirhe" }));
    await expect(api.getCandidates()).rejects.toThrow("Palvelinvirhe");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Each of these has a side effect that a retry after a lost response repeats.
  test.each([
    ["NGO submission", (api) => api.submitQuestionSet({ title: "T" })],
    ["sending every candidate their link", (api) => api.sendPartyCandidateLinks("secret", "id")],
    ["candidate registration", (api) => api.register("token", { name: "N" })],
    ["saving a candidate's profile and answers", (api) => api.saveOwnProfile("token", { name: "N" }, {})],
    ["approving a question set", (api) => api.approveQuestionSet("secret", "id")],
    ["deleting a party", (api) => api.deleteParty("secret", "id")],
  ])("%s is not retried on a transient upstream error", async (_, call) => {
    const { api, fetch } = apiWith(jsonResponse(504, {}), jsonResponse(200, {}));
    await expect(call(api)).rejects.toThrow("HTTP 504");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("a POST is not retried on a network error", async () => {
    const { api, fetch } = apiWith(networkError(), jsonResponse(201, {}));
    await expect(api.submitQuestionSet({ title: "T" })).rejects.toThrow("Failed to fetch");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// #17: one request, so the server can save both or neither.
describe("saveOwnProfile", () => {
  test("sends the profile and the answers in a single PUT", async () => {
    const { api, fetch } = apiWith(jsonResponse(200, { saved: 1, skipped: [] }));
    const qId = "660e8400-e29b-41d4-a716-446655440000";
    await api.saveOwnProfile("tok", { name: "Eeva", photoUrl: "" }, { [qId]: { value: 2, explanation: "" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe("/api/candidates/me/tok");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ name: "Eeva", photoUrl: "", answers: { [qId]: { value: 2, explanation: "" } } });
  });

  test("a reply without saved (a backend that ignores answers) is an error", async () => {
    const { api } = apiWith(jsonResponse(200, { id: "c", name: "Eeva" }));
    await expect(api.saveOwnProfile("tok", { name: "Eeva" }, {})).rejects.toMatchObject({ answersIgnored: true });
  });

  test("a reply with saved resolves with saved and skipped", async () => {
    const { api } = apiWith(jsonResponse(200, { name: "Eeva", saved: 0, skipped: ["x"] }));
    await expect(api.saveOwnProfile("tok", { name: "Eeva" }, {})).resolves.toMatchObject({ saved: 0, skipped: ["x"] });
  });
});

describe("voterMatch", () => {
  const sentBody = (fetch, call) => JSON.parse(fetch.mock.calls[call][1].body);

  test("is retried once with the same client-generated sessionId", async () => {
    const { api, fetch } = apiWith(jsonResponse(502, {}), jsonResponse(200, { results: [] }));
    await api.voterMatch({ answers: { q: 2 } });
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = sentBody(fetch, 0);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentBody(fetch, 1).sessionId).toBe(first.sessionId);
  });

  test("each submission gets a fresh sessionId", async () => {
    const { api, fetch } = apiWith(jsonResponse(200, { results: [] }), jsonResponse(200, { results: [] }));
    await api.voterMatch({ answers: { q: 2 } });
    await api.voterMatch({ answers: { q: 2 } });
    expect(sentBody(fetch, 1).sessionId).not.toBe(sentBody(fetch, 0).sessionId);
  });

  // Outside secure contexts the server picks the id, so a retry would store a
  // second research session.
  test("without crypto.randomUUID it sends no sessionId and is not retried", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      const { api, fetch } = apiWith(jsonResponse(502, {}), jsonResponse(200, { results: [] }));
      await expect(api.voterMatch({ answers: { q: 2 } })).rejects.toThrow("HTTP 502");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sentBody(fetch, 0)).not.toHaveProperty("sessionId");
    } finally {
      Object.defineProperty(globalThis, "crypto", original);
    }
  });
});

// The token-gated views show "invalid link" only when the server rejected the
// token; a failure that may pass gets a retry instead.
describe("isTransientError", () => {
  let isTransientError;
  beforeAll(async () => {
    ({ isTransientError } = await import("../../vaalikone-frontend/src/api.js"));
  });

  test.each([400, 404])("a %i (malformed or unknown token) is not transient", async (status) => {
    const { api } = apiWith(jsonResponse(status, {}));
    expect(isTransientError(await api.getOwnProfile("t").catch((e) => e))).toBe(false);
  });

  test("an unknown token keeps the server's message and status", async () => {
    const { api } = apiWith(jsonResponse(404, { error: "Virheellinen ehdokastunniste" }));
    const err = await api.getOwnProfile("nope").catch((e) => e);
    expect(err.message).toBe("Virheellinen ehdokastunniste");
    expect(err.status).toBe(404);
  });

  // The token routes never send 401/403; behind Cloudflare a 403 is a WAF or
  // challenge response, which says nothing about the token.
  test.each([401, 403, 429, 500, 503])("a %i is transient", async (status) => {
    const { api } = apiWith(jsonResponse(status, {}), jsonResponse(status, {}));
    const err = await api.getRegistration("t").catch((e) => e);
    expect(err.status).toBe(status);
    expect(isTransientError(err)).toBe(true);
  });

  test("a network error is transient", async () => {
    const { api } = apiWith(networkError(), networkError());
    expect(isTransientError(await api.getOwnProfile("t").catch((e) => e))).toBe(true);
  });

  test("a network error on a request that isn't retried is transient", async () => {
    const { api } = apiWith(networkError());
    expect(isTransientError(await api.register("t", {}).catch((e) => e))).toBe(true);
  });

  test("a 200 whose body can't be read is transient", async () => {
    const dropped = { ok: true, status: 200, json: async () => { throw new TypeError("network error"); } };
    const { api } = apiWith(dropped);
    expect(isTransientError(await api.getOwnProfile("t").catch((e) => e))).toBe(true);
  });

  // e.g. a response of an unexpected shape: retrying won't help.
  test("an error that didn't come from the request is not transient", () => {
    expect(isTransientError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
  });
});

// #37: each token or id is one path segment. The browser resolves the URL
// before sending it, so an unencoded `..` climbs a level and `#` cuts the
// path short. The mock fetch gets the raw string; resolving it the way the
// browser does shows the path that would reach the server.
describe("path parameters", () => {
  const sentPath = (fetch) => new URL(fetch.mock.calls[0][0], "http://localhost").pathname;
  const tokenCalls = [
    ["getPartyOverview", (api, t) => api.getPartyOverview(t), "/api/candidates/party/T"],
    ["rotateRegistrationLink", (api, t) => api.rotateRegistrationLink(t), "/api/candidates/party/T/registration-token"],
    ["sendCandidateLink", (api, t) => api.sendCandidateLink(t, "c1"), "/api/candidates/party/T/candidates/c1/send-link"],
    ["removeCandidate", (api, t) => api.removeCandidate(t, "c1"), "/api/candidates/party/T/candidates/c1"],
    ["getRegistration", (api, t) => api.getRegistration(t), "/api/candidates/register/T"],
    ["register", (api, t) => api.register(t, {}), "/api/candidates/register/T"],
    ["getOwnProfile", (api, t) => api.getOwnProfile(t), "/api/candidates/me/T"],
    ["saveOwnProfile", (api, t) => api.saveOwnProfile(t, {}, {}), "/api/candidates/me/T"],
  ];

  test.each(tokenCalls)("%s sends #, %%, / and \\ in the token encoded", async (_, call, expected) => {
    const { api, fetch } = apiWith(jsonResponse(404, {}));
    await call(api, "a#b%zz/c?d\\e").catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentPath(fetch)).toBe(expected.replace("T", "a%23b%25zz%2Fc%3Fd%5Ce"));
  });

  // encodeURIComponent leaves dots alone, and browsers resolve %2E%2E as ..
  // too, so these can't be sent as a segment at all. nginx picks its location
  // after decoding %2F, so `../..` encoded would still climb out of /api/.
  // A lone surrogate can't be encoded. No real token is any of these.
  const badTokens = ["..", ".", "", "../../..", "x/..", "./x", "\uD800"];
  test.each(tokenCalls.flatMap(([name, call]) => badTokens.map((t) => [name, JSON.stringify(t), call, t])))(
    "%s with token %s is refused without a request, as an invalid link",
    async (_, __, call, token) => {
      const { api, fetch } = apiWith(jsonResponse(200, []));
      const err = await call(api, token).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isTransientError(err)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["sendCandidateLink's candidate id", (api) => api.sendCandidateLink("tok", "..")],
    ["removeCandidate's candidate id", (api) => api.removeCandidate("tok", "")],
    ["an admin id", (api) => api.deleteParty("secret", "..")],
    ["getCandidate's id", (api) => api.getCandidate("\uD800")],
  ])("%s is checked too, as a rejection rather than a throw", async (_, call) => {
    const { api, fetch } = apiWith(jsonResponse(200, {}));
    let promise;
    expect(() => { promise = call(api); }).not.toThrow();
    await expect(promise).rejects.toThrow("Virheellinen linkki");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("ids are encoded too", async () => {
    const { api, fetch } = apiWith(jsonResponse(200, {}));
    await api.getCandidate("x/y#z");
    expect(sentPath(fetch)).toBe("/api/candidates/x%2Fy%23z");
  });

  test("a real token goes through unchanged", async () => {
    const token = "0123456789abcdef".repeat(3);
    const { api, fetch } = apiWith(jsonResponse(200, { party: { name: "P" } }));
    await api.getPartyOverview(token);
    expect(fetch.mock.calls[0][0]).toBe(`/api/candidates/party/${token}`);
  });
});
