const fs = require("fs");
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
    expect(outcome).toEqual({ step: "match-failed", error: expect.any(String) });
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
