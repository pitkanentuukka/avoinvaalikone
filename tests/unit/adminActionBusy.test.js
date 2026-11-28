// #225: AdminView kept one loading slot for all admin actions, so one action
// finishing re-enabled another's button while that one was still running, and
// a second click on "Lisää" created a duplicate party.
const {
  PARTY_ID, party, loadAdminView, adminHarness, findButton, button, input, settle, json, pending,
} = require("../helpers/adminView");

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
afterEach(() => { delete global.fetch; });

const createRequests = () => global.fetch.mock.calls.filter(([url, opts]) => (
  url === "/api/admin/parties" && opts?.method === "POST"
));

describe("overlapping admin actions (#225)", () => {
  test("adding a party stays loading while another action finishes first", async () => {
    const create = pending(json(201, { ...party, id: "770e8400-e29b-41d4-a716-446655440000", name: "Uusi" }));
    await login({
      "POST /api/admin/parties": [create],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(204)],
    });
    input(view(), t.adminPartyNamePlaceholder).onChange("Uusi");
    const adding = button(view(), t.adminAdd)();
    expect(findButton(view(), t.adminAdd).loading).toBe(true);

    await click(t.adminDelete);
    expect(findButton(view(), t.adminAdd).loading).toBe(true);

    create.finish();
    await adding;
    expect(findButton(view(), t.adminAdd).loading).toBe(false);
    expect(input(view(), t.adminPartyNamePlaceholder).value).toBe("");
    expect(createRequests()).toHaveLength(1);
  });

  test("a second click before the re-render doesn't create the party twice", async () => {
    const create = pending(json(201, party));
    await login({ "POST /api/admin/parties": [create] });
    input(view(), t.adminPartyNamePlaceholder).onChange("Uusi");
    const onClick = button(view(), t.adminAdd);
    const adding = onClick();
    // The same render's handler, as a double click landing before React re-renders.
    const second = onClick();
    await settle();
    create.finish();
    await Promise.all([adding, second]);
    expect(createRequests()).toHaveLength(1);
  });

  test("any running action keeps its spinner when another one finishes", async () => {
    const rotation = pending(json(200, party));
    await login({
      [`POST /api/admin/parties/${PARTY_ID}/token`]: [rotation],
      [`DELETE /api/admin/parties/${PARTY_ID}`]: [() => json(204)],
    });
    const rotating = button(view(), t.adminRotatePartyToken)();
    await click(t.adminDelete);
    expect(findButton(view(), t.adminRotatePartyToken).loading).toBe(true);

    rotation.finish();
    await rotating;
    expect(findButton(view(), t.adminRotatePartyToken).loading).toBe(false);
  });
});
