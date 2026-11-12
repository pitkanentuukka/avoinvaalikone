// The frontend is an ES module package, so it is loaded with import() (npm test
// runs Jest with --experimental-vm-modules for this).
let createApi;
beforeAll(async () => {
  ({ createApi } = await import("../../vaalikone-frontend/src/api.js"));
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
    ["saving candidate answers", (api) => api.saveOwnAnswers("token", {})],
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
// token; anything else is temporary and gets a retry instead.
describe("isInvalidLinkError", () => {
  let isInvalidLinkError;
  beforeAll(async () => {
    ({ isInvalidLinkError } = await import("../../vaalikone-frontend/src/api.js"));
  });

  test("an unknown token (404) is an invalid link", async () => {
    const { api } = apiWith(jsonResponse(404, { error: "Virheellinen ehdokastunniste" }));
    const err = await api.getOwnProfile("nope").catch((e) => e);
    expect(err.message).toBe("Virheellinen ehdokastunniste");
    expect(err.status).toBe(404);
    expect(isInvalidLinkError(err)).toBe(true);
  });

  test.each([401, 403])("a %i is an invalid link", async (status) => {
    const { api } = apiWith(jsonResponse(status, {}));
    expect(isInvalidLinkError(await api.getPartyOverview("t").catch((e) => e))).toBe(true);
  });

  test.each([429, 500, 503])("a %i is not an invalid link", async (status) => {
    const { api } = apiWith(jsonResponse(status, {}), jsonResponse(status, {}));
    const err = await api.getRegistration("t").catch((e) => e);
    expect(err.status).toBe(status);
    expect(isInvalidLinkError(err)).toBe(false);
  });

  test("a network error is not an invalid link", async () => {
    const { api } = apiWith(networkError(), networkError());
    expect(isInvalidLinkError(await api.getOwnProfile("t").catch((e) => e))).toBe(false);
  });
});
