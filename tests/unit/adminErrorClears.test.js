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
  ui.harness.mount({ lang: "fi", t, setLang: () => {} });
  const input = [...elements(view())].find((el) => el.props.placeholder === t.adminPasswordPlaceholder);
  input.props.onChange("salasana");
  await click(t.adminLogin);
  expect(text(view())).toContain(t.adminPanelTitle);
}

afterEach(() => { delete global.fetch; });

describe("admin error banner (#212)", () => {
  test("clears when a later action succeeds", async () => {
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [
        () => json(500, { error: "Poisto epäonnistui" }),
        () => json(204),
      ],
    });
    await click(t.adminDelete);
    expect(banner(view())?.message).toBe("Poisto epäonnistui");

    await click(t.adminDelete);
    expect(banner(view())).toBeNull();
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
    expect(banner(view())?.message).toBe("Poisto epäonnistui");

    const rotation = button(view(), t.adminRotatePartyToken)();
    expect(banner(view())).toBeNull();
    finishRotation();
    await rotation;
    expect(banner(view())).toBeNull();
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
    expect(banner(view())?.message).toBe("Ehdokkaan sähköpostiosoite on muuttunut");

    await click(t.adminRotateCandidateLink);
    expect(text(view())).toContain(t.adminCandidateLinkRotated(true));
    expect(banner(view())).toBeNull();
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
    const { message, onRetry } = banner(view());
    expect(message).toBe("Poisto epäonnistui");

    const reload = onRetry();
    expect(banner(view())).toBeNull();
    finishReload();
    await reload;
    expect(banner(view())).toBeNull();
  });

  test("a retry whose reload fails shows that failure", async () => {
    await login({
      "GET /api/admin/parties": [() => json(200, [party]), () => json(500, { error: "Lataus epäonnistui" })],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
    });
    await click(t.adminDelete);
    await banner(view()).onRetry();
    expect(banner(view())?.message).toBe("Lataus epäonnistui");
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
    expect(banner(view())?.message).toBe("Poisto epäonnistui");

    button(view(), t.adminShowCandidates)();
    expect(banner(view())).toBeNull();
    finishLoad();
    await settle();
    expect(banner(view())).toBeNull();
  });

  test("a later action's own failure still shows", async () => {
    await login({
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(500, { error: "Poisto epäonnistui" })],
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [() => json(500, { error: "Vaihto epäonnistui" })],
    });
    await click(t.adminDelete);
    await click(t.adminRotatePartyToken);
    expect(banner(view())?.message).toBe("Vaihto epäonnistui");
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
    expect(banner(view())?.message).toBe("Vaihto epäonnistui");

    finishDelete();
    await deletion;
    expect(banner(view())?.message).toBe("Vaihto epäonnistui");
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
    expect(banner(view())?.message).toBe("Vaihto epäonnistui");

    // The UI disables the button meanwhile, but a second click can land before
    // that render: linkAction's busy guard refuses it.
    button(view(), t.adminShowCandidates, { evenIfDisabled: true })();
    await settle();
    expect(banner(view())?.message).toBe("Vaihto epäonnistui");
    finishLoad();
    await settle();
  });
});
