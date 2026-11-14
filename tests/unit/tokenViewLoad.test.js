const fs = require("fs");
const path = require("path");

let isTransientError, distinctQuestions, answersFromProfile;
beforeAll(async () => {
  ({ isTransientError } = await import("../../vaalikone-frontend/src/api.js"));
  ({ distinctQuestions } = await import("../../vaalikone-frontend/src/questions.js"));
  ({ answersFromProfile } = await import("../../vaalikone-frontend/src/candidateAnswers.js"));
});

// Execute the actual loading function from each view with API and state setters
// injected. No DOM is needed to check which error state the effect selects.
function loadView(view, tokenRequest, questionRequest) {
  const source = fs.readFileSync(path.join(__dirname, "../../vaalikone-frontend/src/App.jsx"), "utf8");
  const component = source.slice(source.indexOf(`function ${view}(`));
  const start = component.indexOf("async function load()");
  const end = component.indexOf("\n    load();", start);
  if (start < 0 || end < 0) throw new Error(`Loading function not found in ${view}`);
  const state = {};
  const deps = {
    api: { getPartyOverview: tokenRequest, getOwnProfile: tokenRequest, getQuestionSets: questionRequest },
    partyToken: "party-token", candidateToken: "candidate-token",
    isTransientError, distinctQuestions, answersFromProfile,
    ...Object.fromEntries([
      "Loading", "LoadFailed", "Invalid", "Data", "QuestionCount", "PartyName", "QuestionSets", "Profile", "Answers",
    ].map((key) => [`set${key}`, (value) => { state[key] = value; }])),
  };
  const run = new Function(...Object.keys(deps), `${component.slice(start, end)}\nreturn load();`);
  return run(...Object.values(deps)).then(() => state);
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const ok = { name: "Eeva", party: { name: "Party" }, answers: {} };

describe.each(["PartyView", "CandidateView"])("%s load errors (#87)", (view) => {
  test.each([
    [404, 503, true],
    [400, 503, true],
    [503, 404, false],
    [503, 400, false],
  ])("token HTTP %i wins over an earlier question-set HTTP %i", async (tokenStatus, questionStatus, invalid) => {
    let rejectToken;
    const token = new Promise((_, reject) => { rejectToken = reject; });
    const loaded = loadView(view, () => token, async () => { throw httpError(questionStatus); });
    // Let the public request's rejection reach the loading function first.
    await new Promise((resolve) => setImmediate(resolve));
    rejectToken(httpError(tokenStatus));
    const state = await loaded;
    expect(state.Loading).toBe(false);
    expect(Boolean(state.Invalid)).toBe(invalid);
    expect(state.LoadFailed).toBe(!invalid);
  });

  test.each([400, 404, 503])("a question-set HTTP %i after token success offers retry", async (status) => {
    const state = await loadView(view, async () => ok, async () => { throw httpError(status); });
    expect(state.LoadFailed).toBe(true);
    expect(state.Invalid).not.toBe(true);
    expect(state.Loading).toBe(false);
  });

  test.each([404, 503])("an earlier token HTTP %i also determines the error", async (status) => {
    let rejectQuestions;
    const questions = new Promise((_, reject) => { rejectQuestions = reject; });
    const loaded = loadView(view, async () => { throw httpError(status); }, () => questions);
    await new Promise((resolve) => setImmediate(resolve));
    rejectQuestions(httpError(status === 404 ? 503 : 404));
    const state = await loaded;
    expect(Boolean(state.Invalid)).toBe(status === 404);
    expect(state.LoadFailed).toBe(status !== 404);
    expect(state.Loading).toBe(false);
  });

  test("successful requests populate the view", async () => {
    const state = await loadView(view, async () => ok, async () => []);
    expect(state.Loading).toBe(false);
    expect(state.LoadFailed).toBe(false);
    expect(state.Invalid).not.toBe(true);
    if (view === "PartyView") {
      expect(state.Data).toEqual(ok);
      expect(state.QuestionCount).toBe(0);
    } else {
      expect(state.PartyName).toBe("Party");
      expect(state.Profile.name).toBe("Eeva");
      expect(state.Answers).toEqual({});
    }
  });
});
