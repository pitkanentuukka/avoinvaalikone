// #212: an admin action's error banner stays up after a later action
// succeeds. AdminView runs with a hooks stand-in (tests/helpers/fakeHooks.js)
// in place of React, so its real handlers run against a mocked fetch without a DOM.
const path = require("path");
const { loadFrontend } = require("../helpers/frontendBundle");

const FAKE_HOOKS = path.resolve(__dirname, "../helpers/fakeHooks.js");
const PARTY_ID = "550e8400-e29b-41d4-a716-446655440000";
const CANDIDATE_ID = "660e8400-e29b-41d4-a716-446655440000";
const party = { id: PARTY_ID, name: "Puolue", email: "sihteeri@example.fi", token: "a".repeat(48) };
const candidate = (token, email) => ({
  id: CANDIDATE_ID, name: "Eeva", email, token, constituency: "Helsingin vaalipiiri", answerCount: 0,
});

let ui;
let t;
beforeAll(async () => {
  ui = await loadFrontend(`
    export { AdminView } from "./App.jsx";
    export { default as translations } from "./translations.js";
    export { harness } from ${JSON.stringify(FAKE_HOOKS)};
  `, [{
    name: "admin-view-with-fake-hooks",
    setup(build) {
      // Only App.jsx's own hooks: its other dependencies (Sentry) need the real React.
      build.onResolve({ filter: /^react$/ }, ({ importer }) => (
        importer.endsWith(`${path.sep}App.jsx`) ? { path: FAKE_HOOKS } : undefined
      ));
    },
  }]);
  t = ui.translations.fi;
  global.window = { confirm: () => true, location: { origin: "https://vaalikone.test" } };
}, 30_000);

afterAll(() => { delete global.window; });

// ── Element tree helpers ──
function* elements(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object" && node.props) {
    yield node;
    yield* elements(node.props.children);
  }
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node?.props ? text(node.props.children) : "";
}
// Child components aren't rendered, so a disabled or loading Button's handler
// would still run: refuse that unless a test means to click it anyway.
function button(tree, label, { evenIfDisabled = false } = {}) {
  const found = [...elements(tree)].filter((el) => el.props.onClick && text(el) === label);
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  const { onClick, disabled, loading } = found[0].props;
  if ((disabled || loading) && !evenIfDisabled) throw new Error(`"${label}" button is disabled`);
  return onClick;
}
// Some handlers don't return their promise (togglePartyCandidates), so let
// the mocked requests finish before looking at the result.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function click(label) {
  await button(view(), label)();
  await settle();
}
function banner(tree) {
  return [...elements(tree)].find((el) => el.type?.name === "ErrorBanner")?.props ?? null;
}
// The messages the error banner shows, in order; [] when there is none.
function shownErrors(tree = view()) {
  const props = banner(tree);
  if (!props) return [];
  return props.messages ?? [props.message];
}

// ── Mocked backend ──
function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
// `handlers` maps "METHOD /api/path" to a list of responses, used in order.
function mockBackend(handlers) {
  global.fetch = jest.fn(async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    const queue = handlers[key];
    if (!queue?.length) throw new Error(`unexpected request ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === "function" ? next() : next;
  });
}

const view = () => ui.harness.render(ui.AdminView);

async function login(handlers) {
  mockBackend({
    "GET /api/admin/parties": [() => json(200, [party])],
    "GET /api/admin/question-sets": [() => json(200, [])],
    ...handlers,
  });
  ui.harness.mount({ lang: t === ui.translations.en ? "en" : "fi", t, setLang: () => {} });
  const input = [...elements(view())].find((el) => el.props.placeholder === t.adminPasswordPlaceholder);
  input.props.onChange("salasana");
  await click(t.adminLogin);
  expect(text(view())).toContain(t.adminPanelTitle);
}

afterEach(() => { delete global.fetch; t = ui.translations.fi; });

describe("admin error banner (#212)", () => {
  test("localizes an action failure and clears it on a later action", async () => {
    t = ui.translations.en;
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [
        () => json(500),
        () => json(204),
      ],
    });
    await click(t.adminDelete);
    expect(shownErrors()).toEqual([t.requestFailed(500)]);

    await click(t.adminDelete);
    expect(shownErrors()).toEqual([]);
  });

  test("clears when a later action succeeds", async () => {
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [
        () => json(500, { error: "Poisto epäonnistui" }),
        () => json(204),
      ],
    });
    await click(t.adminDelete);
    expect(shownErrors()).toEqual(["Poisto epäonnistui"]);

    await click(t.adminDelete);
    expect(shownErrors()).toEqual([]);
  });

  test("clears as soon as the next action starts", async () => {
    let finishRotation;
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [
        () => new Promise((resolve) => { finishRotation = () => resolve(json(200, party)); }),
      ],
    });
    await click(t.adminDelete);
    expect(shownErrors()).toEqual(["Poisto epäonnistui"]);

    const rotation = button(view(), t.adminRotatePartyToken)();
    expect(shownErrors()).toEqual([]);
    finishRotation();
    await rotation;
    expect(shownErrors()).toEqual([]);
  });

  test("a candidate link rotation refused with 409 is cleared by a successful retry", async () => {
    await login({
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => json(200, [candidate("b".repeat(48), "vanha@example.fi")]),
        () => json(200, [candidate("b".repeat(48), "uusi@example.fi")]),
        () => json(200, [candidate("c".repeat(48), "uusi@example.fi")]),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/candidates/${CANDIDATE_ID}/token`]: [
        () => json(409, { error: "Ehdokkaan sähköpostiosoite on muuttunut" }),
        () => json(200, { token: "c".repeat(48), emailed: true }),
      ],
    });
    await click(t.adminShowCandidates);
    await click(t.adminRotateCandidateLink);
    expect(shownErrors()).toEqual(["Ehdokkaan sähköpostiosoite on muuttunut"]);

    await click(t.adminRotateCandidateLink);
    expect(text(view())).toContain(t.adminCandidateLinkRotated(true));
    expect(shownErrors()).toEqual([]);
  });

  test("the banner's retry clears it as the reload starts", async () => {
    let finishReload;
    await login({
      "GET /api/admin/parties": [
        () => json(200, [party]),
        () => new Promise((resolve) => { finishReload = () => resolve(json(200, [party])); }),
      ],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
    });
    await click(t.adminDelete);
    expect(shownErrors()).toEqual(["Poisto epäonnistui"]);
    const { onRetry } = banner(view());

    const reload = onRetry();
    expect(shownErrors()).toEqual([]);
    finishReload();
    await reload;
    expect(shownErrors()).toEqual([]);
  });

  test("a retry whose reload fails shows that failure", async () => {
    await login({
      "GET /api/admin/parties": [() => json(200, [party]), () => json(500, { error: "Lataus epäonnistui" })],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
    });
    await click(t.adminDelete);
    await banner(view()).onRetry();
    expect(shownErrors()).toEqual(["Lataus epäonnistui"]);
  });

  test("a candidate-link action clears the error as it starts", async () => {
    let finishLoad;
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => new Promise((resolve) => { finishLoad = () => resolve(json(200, [])); }),
      ],
    });
    await click(t.adminDelete);
    expect(shownErrors()).toEqual(["Poisto epäonnistui"]);

    button(view(), t.adminShowCandidates)();
    expect(shownErrors()).toEqual([]);
    finishLoad();
    await settle();
    expect(shownErrors()).toEqual([]);
  });

  test("a later action's own failure still shows", async () => {
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [() => json(500, { error: "Vaihto epäonnistui" })],
    });
    await click(t.adminDelete);
    await click(t.adminRotatePartyToken);
    expect(shownErrors()).toEqual(["Vaihto epäonnistui"]);
  });

  test("an action finishing doesn't hide an error from one that failed while it ran", async () => {
    let finishDelete;
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [
        () => new Promise((resolve) => { finishDelete = () => resolve(json(204)); }),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [() => json(500, { error: "Vaihto epäonnistui" })],
    });
    const deletion = button(view(), t.adminDelete)();
    await click(t.adminRotatePartyToken);
    expect(shownErrors()).toEqual(["Vaihto epäonnistui"]);

    finishDelete();
    await deletion;
    expect(shownErrors()).toEqual(["Vaihto epäonnistui"]);
  });

  test("a candidate-link click refused while another is running leaves the error", async () => {
    let finishLoad;
    await login({
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => new Promise((resolve) => { finishLoad = () => resolve(json(200, [])); }),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [() => json(500, { error: "Vaihto epäonnistui" })],
    });
    await click(t.adminShowCandidates);
    await click(t.adminRotatePartyToken);
    expect(shownErrors()).toEqual(["Vaihto epäonnistui"]);

    // The UI disables the button meanwhile, but a second click can land before
    // that render: linkAction's busy guard refuses it.
    button(view(), t.adminShowCandidates, { evenIfDisabled: true })();
    await settle();
    expect(shownErrors()).toEqual(["Vaihto epäonnistui"]);
    finishLoad();
    await settle();
  });
});

// #226: the banner held one message, so a later failure replaced an earlier
// one and the admin never saw why the first action failed.
describe("every failure stays visible (#226)", () => {
  test("two overlapping actions that both fail show both errors", async () => {
    let failRotation;
    await login({
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [
        () => new Promise((resolve) => { failRotation = () => resolve(json(500, { error: "Vaihto epäonnistui" })); }),
      ],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
    });
    const rotation = button(view(), t.adminRotatePartyToken)();
    await click(t.adminDelete);
    failRotation();
    await rotation;
    expect(shownErrors()).toEqual(["Poisto epäonnistui", "Vaihto epäonnistui"]);
  });

  test("a candidate link rotation's own error survives a failed list refresh", async () => {
    await login({
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => json(200, [candidate("b".repeat(48), "vanha@example.fi")]),
        () => json(500, { error: "Lataus epäonnistui" }),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/candidates/${CANDIDATE_ID}/token`]: [
        () => json(409, { error: "Ehdokkaan sähköpostiosoite on muuttunut" }),
      ],
    });
    await click(t.adminShowCandidates);
    await click(t.adminRotateCandidateLink);
    expect(shownErrors()).toEqual([
      "Ehdokkaan sähköpostiosoite on muuttunut",
      t.adminLinksRotatedRefreshFailed,
    ]);
  });

  test("rotating every link: its own error survives a failed list refresh", async () => {
    await login({
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => json(200, [candidate("b".repeat(48), "eeva@example.fi")]),
        () => json(500, { error: "Lataus epäonnistui" }),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/candidate-tokens`]: [() => json(500, { error: "Vaihto epäonnistui" })],
    });
    await click(t.adminShowCandidates);
    await click(t.adminRotateAllLinks);
    expect(shownErrors()).toEqual(["Vaihto epäonnistui", t.adminLinksRotatedRefreshFailed]);
  });

  test("the same message twice is shown once, next to a different one", async () => {
    let failRotation, failCreate;
    await login({
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [
        () => new Promise((resolve) => { failRotation = () => resolve(json(503)); }),
      ],
      "POST /api/admin/parties": [
        () => new Promise((resolve) => { failCreate = () => resolve(json(500, { error: "Lisäys epäonnistui" })); }),
      ],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(503)],
    });
    const rotation = button(view(), t.adminRotatePartyToken)();
    [...elements(view())].find((el) => el.props.placeholder === t.adminPartyNamePlaceholder).props.onChange("Uusi");
    const creation = button(view(), t.adminAdd)();
    await click(t.adminDelete);
    failRotation();
    await rotation;
    failCreate();
    await creation;
    expect(shownErrors()).toEqual([t.requestFailed(503), "Lisäys epäonnistui"]);
  });

  // An action started while the rotation's list refresh runs clears the
  // errors so far: the rotation's own error must not be among them.
  test.each([
    ["one candidate's link", `candidates/${CANDIDATE_ID}/token`, () => t.adminRotateCandidateLink,
      () => json(409, { error: "Ehdokkaan sähköpostiosoite on muuttunut" }), "Ehdokkaan sähköpostiosoite on muuttunut"],
    ["every link", "candidate-tokens", () => t.adminRotateAllLinks,
      () => json(500, { error: "Vaihto epäonnistui" }), "Vaihto epäonnistui"],
  ])("rotating %s: its error survives an action started during the refresh", async (_, route, label, failure, message) => {
    let failRefresh;
    await login({
      [`GET /api/admin/parties/${PARTY_ID}/candidates`]: [
        () => json(200, [candidate("b".repeat(48), "eeva@example.fi")]),
        () => new Promise((resolve) => { failRefresh = () => resolve(json(500, { error: "Lataus epäonnistui" })); }),
      ],
      [`POST /api/admin/parties/${PARTY_ID}/${route}`]: [failure],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [() => json(200, party)],
    });
    await click(t.adminShowCandidates);
    const rotation = button(view(), label())();
    await settle();
    await click(t.adminRotatePartyToken);
    failRefresh();
    await rotation;
    expect(shownErrors()).toEqual([message, t.adminLinksRotatedRefreshFailed]);
  });

  test("the next action clears them all as it starts", async () => {
    let failRotation;
    await login({
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [
        () => new Promise((resolve) => { failRotation = () => resolve(json(500, { error: "Vaihto epäonnistui" })); }),
        () => json(200, party),
      ],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
    });
    const rotation = button(view(), t.adminRotatePartyToken)();
    await click(t.adminDelete);
    failRotation();
    await rotation;
    expect(shownErrors()).toHaveLength(2);

    await click(t.adminRotatePartyToken);
    expect(shownErrors()).toEqual([]);
  });
});
