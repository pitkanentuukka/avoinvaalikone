const fs = require("fs");
const path = require("path");
const { loadFrontend } = require("../helpers/frontendBundle");

// Issue #153: when the match request still failed after the API client's
// automatic retry, the voter view went to the results screen with the error.
// That screen offered no retry and no way back to weighting, and its "Start
// over" cleared the answers, so the voter had to answer everything again
// (with browser storage declined, nothing else had them either).
//
// The match submission now lives in vaalikone-frontend/src/voterMatch.js:
// a failure leads to its own step, and a retry resends the same submission
// (answers, weights, sets, constituency, research choice) with the same
// sessionId, so a retry after a lost response doesn't record the research
// answers twice.

let createApi, newMatchSubmission, runMatch;
beforeAll(async () => {
  ({ createApi } = await import("../../vaalikone-frontend/src/api.js"));
  ({ newMatchSubmission, runMatch } = await import("../../vaalikone-frontend/src/voterMatch.js"));
});

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function apiWith(...outcomes) {
  const fetch = jest.fn(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { api: createApi({ base: "/api", fetch, retryDelayMs: 0 }), fetch };
}

const sent = (fetch) => fetch.mock.calls.map(([, init]) => JSON.parse(init.body));

const PAYLOAD = {
  answers: { q1: 4, q2: 0 },
  weights: { q1: 3 },
  questionSetIds: ["s1"],
  constituency: "Helsingin vaalipiiri",
  includeInResearch: false,
};

describe("runMatch", () => {
  test("a match that fails after the client's own retry leads to the failure step", async () => {
    const { api, fetch } = apiWith(jsonResponse(503, {}), jsonResponse(503, {}));
    const outcome = await runMatch(api, newMatchSubmission(PAYLOAD));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ step: "match-failed", error: null });
  });

  // The failure step explains itself; only the app's own messages (JSON
  // `error` on a 4xx, in Finnish) add anything. "Failed to fetch" or
  // "HTTP 503" would be English noise in the Finnish UI.
  const htmlResponse = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  test.each([
    ["a network error", null, [new TypeError("Failed to fetch"), new TypeError("Failed to fetch")]],
    ["a 5xx", null, [jsonResponse(502, {}), jsonResponse(502, {})]],
    ["an HTML 4xx from a proxy or WAF", null, [htmlResponse(403)]],
    ["a 4xx whose JSON has no error", null, [jsonResponse(413, { message: "too large" })]],
    ["the app's own 4xx", "Liian monta pyyntöä.", [jsonResponse(429, { error: "Liian monta pyyntöä." })]],
  ])("after %s the failure step shows %p", async (_what, error, outcomes) => {
    const { api } = apiWith(...outcomes);
    expect(await runMatch(api, newMatchSubmission(PAYLOAD))).toEqual({ step: "match-failed", error });
  });

  test("a retry resends the same submission with the same sessionId", async () => {
    const { api, fetch } = apiWith(
      jsonResponse(503, {}), jsonResponse(503, {}), // first attempt, and the client's retry
      jsonResponse(200, { results: [{ id: "c1", match: 80 }], question_count: 2 }),
    );
    const submission = newMatchSubmission(PAYLOAD);
    await runMatch(api, submission);
    const outcome = await runMatch(api, submission);

    expect(outcome).toEqual({ step: "results", results: [{ id: "c1", match: 80 }], questionCount: 2, error: null });
    const bodies = sent(fetch);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toEqual({ ...PAYLOAD, sessionId: bodies[0].sessionId });
    }
    expect(bodies[0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a new submission gets a new sessionId", () => {
    expect(newMatchSubmission(PAYLOAD).sessionId).not.toBe(newMatchSubmission(PAYLOAD).sessionId);
  });

  // Back to weighting, then Show results with nothing changed: the earlier
  // attempt may have reached the server, so it is the same session.
  test("resubmitting unchanged answers keeps the earlier sessionId", () => {
    const first = newMatchSubmission(PAYLOAD);
    expect(newMatchSubmission({ ...PAYLOAD }, first)).toBe(first);
  });

  test("resubmitting changed answers gets a new sessionId", () => {
    const first = newMatchSubmission(PAYLOAD);
    const changed = newMatchSubmission({ ...PAYLOAD, weights: { q1: 0 } }, first);
    expect(changed.sessionId).not.toBe(first.sessionId);
    expect(changed.payload.weights).toEqual({ q1: 0 });
  });

  test("a submission keeps its own copy of the payload", () => {
    const payload = { ...PAYLOAD, answers: { ...PAYLOAD.answers } };
    const submission = newMatchSubmission(payload);
    payload.answers.q1 = 0;
    expect(submission.payload.answers.q1).toBe(4);
  });

  test("a successful match with no candidates is results, not a failure", async () => {
    const { api } = apiWith(jsonResponse(200, { results: [], question_count: 2 }));
    expect(await runMatch(api, newMatchSubmission(PAYLOAD))).toEqual({
      step: "results", results: [], questionCount: 2, error: null,
    });
  });
});

// The actual handlers from VoterView in App.jsx, run with the API and state
// injected (as in tokenViewLoad.test.js): no DOM is needed to check which
// step a failure leads to and what Retry and Back to weighting do.
function voterHandlers(fetchOutcomes) {
  const source = fs.readFileSync(path.join(__dirname, "../../vaalikone-frontend/src/App.jsx"), "utf8");
  const component = source.slice(source.indexOf("function VoterView("));
  const start = component.indexOf("async function sendMatch()");
  const end = component.indexOf("\n  if (step === \"loading\"", start);
  if (start < 0 || end < 0) throw new Error("VoterView match handlers not found");
  const { api, fetch } = apiWith(...fetchOutcomes);
  const state = {
    step: "weight",
    VoterAnswers: { ...PAYLOAD.answers },
    Weights: { ...PAYLOAD.weights },
    SelectedSetIds: new Set(PAYLOAD.questionSetIds),
  };
  const setter = (key) => (value) => {
    state[key] = typeof value === "function" ? value(state[key]) : value;
  };
  const deps = {
    api, runMatch, newMatchSubmission,
    submissionRef: { current: null },
    voterAnswers: state.VoterAnswers,
    weights: state.Weights,
    selectedSetIds: state.SelectedSetIds,
    constituency: PAYLOAD.constituency,
    includeInResearch: PAYLOAD.includeInResearch,
    setStep: setter("step"),
    ...Object.fromEntries([
      "Error", "Results", "QuestionCount", "VoterAnswers", "Weights", "SelectedSetIds", "Constituency",
    ].map((key) => [`set${key}`, setter(key)])),
  };
  const handlers = new Function(
    ...Object.keys(deps),
    `${component.slice(start, end)}\nreturn { finishWeighting, retryMatch, backToWeighting };`,
  )(...Object.values(deps));
  return { handlers, state, fetch };
}

describe("the voter view's match handlers", () => {
  test("a failed match leads to the failure step, keeping every answer and choice", async () => {
    const { handlers, state } = voterHandlers([jsonResponse(503, {}), jsonResponse(503, {})]);
    await handlers.finishWeighting();
    expect(state.step).toBe("match-failed");
    expect(state.VoterAnswers).toEqual(PAYLOAD.answers);
    expect(state.Weights).toEqual(PAYLOAD.weights);
    expect([...state.SelectedSetIds]).toEqual(PAYLOAD.questionSetIds);
    expect(state.Constituency).toBeUndefined(); // never touched
  });

  test("Retry resends the same submission and sessionId, and shows the results", async () => {
    const { handlers, state, fetch } = voterHandlers([
      jsonResponse(503, {}), jsonResponse(503, {}),
      jsonResponse(200, { results: [{ id: "c1", match: 80 }], question_count: 2 }),
    ]);
    await handlers.finishWeighting();
    await handlers.retryMatch();
    expect(state.step).toBe("results");
    expect(state.Results).toEqual([{ id: "c1", match: 80 }]);
    const bodies = sent(fetch);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toEqual({ ...PAYLOAD, sessionId: bodies[0].sessionId });
  });

  test("Back to weighting keeps every answer and choice", async () => {
    const { handlers, state } = voterHandlers([jsonResponse(503, {}), jsonResponse(503, {})]);
    await handlers.finishWeighting();
    handlers.backToWeighting();
    expect(state.step).toBe("weight");
    expect(state.Error).toBeNull();
    expect(state.VoterAnswers).toEqual(PAYLOAD.answers);
    expect(state.Weights).toEqual(PAYLOAD.weights);
    expect([...state.SelectedSetIds]).toEqual(PAYLOAD.questionSetIds);
  });

  test("the app's own error is shown on the failure step, and cleared on the way back", async () => {
    const { handlers, state } = voterHandlers([jsonResponse(429, { error: "Liian monta pyyntöä." })]);
    await handlers.finishWeighting();
    expect(state.step).toBe("match-failed");
    expect(state.Error).toBe("Liian monta pyyntöä.");
    handlers.backToWeighting();
    expect(state.Error).toBeNull();
  });

  // Start over keeps the selected sets and the research choice, so the next
  // voter on a shared computer can send an identical payload; it must be a
  // session of its own, or the server keeps only the first.
  test("after a successful match, the next submission is a new session even if identical", async () => {
    const { handlers, fetch } = voterHandlers([
      jsonResponse(200, { results: [], question_count: 2 }),
      jsonResponse(200, { results: [], question_count: 2 }),
    ]);
    await handlers.finishWeighting();
    await handlers.finishWeighting();
    const [first, second] = sent(fetch);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("Show results again with nothing changed is the same session", async () => {
    const { handlers, fetch } = voterHandlers([
      jsonResponse(503, {}), jsonResponse(503, {}),
      jsonResponse(200, { results: [], question_count: 2 }),
    ]);
    await handlers.finishWeighting();
    handlers.backToWeighting();
    await handlers.finishWeighting();
    const bodies = sent(fetch);
    expect(new Set(bodies.map((b) => b.sessionId)).size).toBe(1);
  });
});

describe("the voter view's failure step", () => {
  let ui;
  beforeAll(async () => {
    ui = await loadFrontend(`
      export { VoterView, LanguageContext } from "./App.jsx";
      export { default as translations } from "./translations.js";
      export { renderToStaticMarkup } from "react-dom/server";
      export { createElement } from "react";
    `, [{
      name: "voter-match-failed",
      setup(build) {
        build.onLoad({ filter: /\/App\.jsx$/ }, async ({ path }) => {
          const source = await fs.promises.readFile(path, "utf8");
          // Server rendering can't run the quiz. Start the voter view where a
          // failed match leaves it, rendering the actual component markup.
          // Only VoterView's own initializers: other components have the same
          // `error` state line.
          const start = source.indexOf("function VoterView()");
          if (start === -1) throw new Error("VoterView not found");
          let body = source.slice(start);
          const patches = [
            ['const [step, setStep] = useState("loading");', 'const [step, setStep] = useState("match-failed");'],
            ["const [error, setError] = useState(null);", 'const [error, setError] = useState("Palvelinvirhe");'],
          ];
          for (const [from, to] of patches) {
            if (!body.includes(from)) throw new Error(`VoterView state initializer not found: ${from}`);
            body = body.replace(from, to);
          }
          return { contents: `${source.slice(0, start)}${body}\nexport { VoterView, LanguageContext };`, loader: "jsx" };
        });
      },
    }]);
  }, 30_000);

  // Rendered without browser storage (no localStorage under Node), as with
  // storage declined: nothing outside the view's state holds the answers.
  test.each(["fi", "en"])("offers a retry and a way back to weighting, not Start over (%s)", (lang) => {
    const t = ui.translations[lang];
    const h = ui.createElement;
    const html = ui.renderToStaticMarkup(h(ui.LanguageContext.Provider, {
      value: { lang, t, setLang: () => {} },
    }, h(ui.VoterView)));
    const buttons = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(([, label]) => label);

    expect(html).toContain("Palvelinvirhe");
    expect(buttons).toContain(t.retry);
    expect(buttons).toContain(t.voterBackToWeighting);
    expect(buttons).not.toContain(t.voterStartOver);
    expect(html).not.toContain(t.voterNoCandidates);
  });
});
