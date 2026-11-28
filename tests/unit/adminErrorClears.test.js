// #212: an admin action's error banner stays up after a later action
// succeeds. AdminView runs with a hooks stand-in (tests/helpers/fakeHooks.js)
// in place of React, so its real handlers run against a mocked fetch without a DOM.
const {
  PARTY_ID, party, loadAdminView, adminHarness, text, button, banner, settle, json,
} = require("../helpers/adminView");

const CANDIDATE_ID = "660e8400-e29b-41d4-a716-446655440000";
const candidate = (token, email) => ({
  id: CANDIDATE_ID, name: "Eeva", email, token, constituency: "Helsingin vaalipiiri", answerCount: 0,
});

let ui;
let t;
let view, click, login;
beforeAll(async () => {
  ui = await loadAdminView();
  t = ui.translations.fi;
  ({ view, click, login } = adminHarness(ui, () => t));
  global.window = { confirm: () => true, location: { origin: "https://vaalikone.test" } };
}, 30_000);

afterAll(() => { delete global.window; });

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
    expect(banner(view())?.message).toBe(t.requestFailed(500));

    await click(t.adminDelete);
    expect(banner(view())).toBeNull();
  });

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
