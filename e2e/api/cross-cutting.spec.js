// @ts-check
const { test, expect } = require("@playwright/test");
const { API } = require("../helpers");

test.describe("CC-4: Error handling", () => {
  test("non-existent route returns 404", async ({ request }) => {
    const res = await request.get(`${API}/nonexistent`);
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("ei löytynyt");
  });

  test("health check returns ok", async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTruthy();
  });
});

test.describe("CC-3: Input validation", () => {
  test("invalid UUID route param returns 400", async ({ request }) => {
    const res = await request.get(`${API}/candidates/not-a-uuid`);
    expect(res.status()).toBe(400);
  });

  test("too-large JSON body returns 413", async ({ request }) => {
    const bigBody = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
    const res = await request.post(`${API}/question-sets`, {
      data: bigBody,
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(413);
  });
});
