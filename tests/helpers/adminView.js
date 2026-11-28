// Runs AdminView's real handlers against a mocked fetch without a DOM:
// AdminView is bundled with a hooks stand-in (fakeHooks.js) in place of React,
// so calling it returns the element tree and its handlers' state updates are
// there on the next render. Shared by the admin view tests.
const path = require("path");
const { loadFrontend } = require("./frontendBundle");

const FAKE_HOOKS = path.resolve(__dirname, "fakeHooks.js");
const PARTY_ID = "550e8400-e29b-41d4-a716-446655440000";
const party = { id: PARTY_ID, name: "Puolue", email: "sihteeri@example.fi", token: "a".repeat(48) };

function loadAdminView() {
  return loadFrontend(`
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
}

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
function findButton(tree, label) {
  const found = [...elements(tree)].filter((el) => el.props.onClick && text(el) === label);
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  return found[0].props;
}
// Child components aren't rendered, so a disabled or loading Button's handler
// would still run: refuse that unless a test means to click it anyway.
function button(tree, label, { evenIfDisabled = false } = {}) {
  const { onClick, disabled, loading } = findButton(tree, label);
  if ((disabled || loading) && !evenIfDisabled) throw new Error(`"${label}" button is disabled`);
  return onClick;
}
function input(tree, placeholder) {
  const found = [...elements(tree)].find((el) => el.props.placeholder === placeholder);
  if (!found) throw new Error(`expected an input with placeholder "${placeholder}"`);
  return found.props;
}
function banner(tree) {
  return [...elements(tree)].find((el) => el.type?.name === "ErrorBanner")?.props ?? null;
}
// Some handlers don't return their promise (togglePartyCandidates), so let
// the mocked requests finish before looking at the result.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

// A response held back until the test calls `finish()`, which answers every
// request made with it so far, and any made later at once:
// `const create = pending(json(201, party)); … create.finish();`
// Each request gets its own copy, since a Response body can be read only once.
function pending(response) {
  const waiting = [];
  let done = false;
  const handler = () => (done
    ? Promise.resolve(response.clone())
    : new Promise((resolve) => { waiting.push(resolve); }));
  handler.finish = () => {
    done = true;
    for (const resolve of waiting.splice(0)) resolve(response.clone());
  };
  return handler;
}

// Binds the helpers that need the loaded bundle. `getT` returns the
// translations the view is mounted with, so a test can switch language.
function adminHarness(ui, getT) {
  const view = () => ui.harness.render(ui.AdminView);
  async function click(label) {
    await button(view(), label)();
    await settle();
  }
  async function login(handlers) {
    const t = getT();
    mockBackend({
      "GET /api/admin/parties": [() => json(200, [party])],
      "GET /api/admin/question-sets": [() => json(200, [])],
      ...handlers,
    });
    ui.harness.mount({ lang: t === ui.translations.en ? "en" : "fi", t, setLang: () => {} });
    input(view(), t.adminPasswordPlaceholder).onChange("salasana");
    await click(t.adminLogin);
    expect(text(view())).toContain(t.adminPanelTitle);
  }
  return { view, click, login };
}

module.exports = {
  PARTY_ID, party, loadAdminView, adminHarness,
  elements, text, findButton, button, input, banner, settle, json, mockBackend, pending,
};
