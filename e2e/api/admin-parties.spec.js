// @ts-check
const { test, expect } = require("@playwright/test");
const { adminHeaders, post, get, del, createParty, API } = require("../helpers");

test.describe("UC-ADMIN: Party management", () => {
  test("UC-ADMIN-2: create a party", async ({ request }) => {
    const name = `E2E Puolue ${Date.now()}`;
    const { res, body } = await post(
      request,
      "/admin/parties",
      { name, email: "sihteeri@puolue.fi" },
      adminHeaders()
    );
    expect(res.status()).toBe(201);
    expect(body.name).toBe(name);
    expect(body.token).toBeTruthy();
    expect(body.id).toBeTruthy();
    expect(body.email).toBe("sihteeri@puolue.fi");
  });

  test("UC-ADMIN-1: list all parties", async ({ request }) => {
    const name = `Listauspuolue ${Date.now()}`;
    await createParty(request, name);

    const { res, body } = await get(request, "/admin/parties", adminHeaders());
    expect(res.status()).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p) => p.name === name)).toBe(true);
  });

  test("UC-ADMIN-3: delete a party", async ({ request }) => {
    const party = await createParty(request, `Poistettava ${Date.now()}`);

    const { res, body } = await del(
      request,
      `/admin/parties/${party.id}`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify it's gone
    const { body: parties } = await get(request, "/admin/parties", adminHeaders());
    expect(parties.find((p) => p.id === party.id)).toBeUndefined();
  });

  test("delete non-existent party returns 404", async ({ request }) => {
    const { res } = await del(
      request,
      "/admin/parties/00000000-0000-0000-0000-000000000000",
      adminHeaders()
    );
    expect(res.status()).toBe(404);
  });

  test("create party with duplicate name returns 409", async ({ request }) => {
    const name = `Duplikaatti ${Date.now()}`;
    await createParty(request, name);

    const { res } = await post(
      request,
      "/admin/parties",
      { name },
      adminHeaders()
    );
    expect(res.status()).toBe(409);
  });

  test("create party without name returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      "/admin/parties",
      { name: "" },
      adminHeaders()
    );
    expect(res.status()).toBe(400);
  });

  test("create party with too-long name returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      "/admin/parties",
      { name: "A".repeat(101) },
      adminHeaders()
    );
    expect(res.status()).toBe(400);
  });

  test("create party with invalid email returns 400", async ({ request }) => {
    const { res } = await post(
      request,
      "/admin/parties",
      { name: `EmailTest ${Date.now()}`, email: "not-an-email" },
      adminHeaders()
    );
    expect(res.status()).toBe(400);
  });

  test("invalid UUID param returns 400", async ({ request }) => {
    const { res } = await del(
      request,
      "/admin/parties/not-a-uuid",
      adminHeaders()
    );
    expect(res.status()).toBe(400);
  });
});

test.describe("CC-1: Admin authentication", () => {
  test("missing auth header returns 401", async ({ request }) => {
    const res = await request.get(`${API}/admin/parties`);
    expect(res.status()).toBe(401);
  });

  test("wrong bearer token returns 403", async ({ request }) => {
    const res = await request.get(`${API}/admin/parties`, {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(res.status()).toBe(403);
  });
});
