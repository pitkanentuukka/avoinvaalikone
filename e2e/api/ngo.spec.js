// @ts-check
const { test, expect } = require("@playwright/test");
const { post, get, submitQuestionSet, approveQuestionSet, adminHeaders, patch } = require("../helpers");

test.describe("UC-NGO: Question set submission", () => {
  test("UC-NGO-1: submit a question set", async ({ request }) => {
    const { res, body } = await post(request, "/question-sets", {
      ngoName: "Ilmastojärjestö",
      ngoEmail: "info@ilmasto.fi",
      logoUrl: "https://example.com/logo.png",
      title: `E2E Kysymykset ${Date.now()}`,
      questions: [
        "Suomen tulee vähentää päästöjä 50% vuoteen 2030 mennessä",
        "Ydinvoimaa tulee lisätä",
      ],
    });
    expect(res.status()).toBe(201);
    expect(body.status).toBe("pending");
    expect(body.ngo_name).toBe("Ilmastojärjestö");
    expect(body.questions).toHaveLength(2);
    expect(body.questions[0].statement).toBeTruthy();
    expect(body.questions[0].id).toBeTruthy();
  });

  test("submit with questions as string array", async ({ request }) => {
    const { res, body } = await post(request, "/question-sets", {
      ngoName: "StringTest",
      title: `String ${Date.now()}`,
      questions: ["Väittämä A", "Väittämä B"],
    });
    expect(res.status()).toBe(201);
    expect(body.questions).toHaveLength(2);
  });

  test("submit with questions as object array", async ({ request }) => {
    const { res, body } = await post(request, "/question-sets", {
      ngoName: "ObjectTest",
      title: `Object ${Date.now()}`,
      questions: [{ statement: "Väittämä X" }, { statement: "Väittämä Y" }],
    });
    expect(res.status()).toBe(201);
    expect(body.questions).toHaveLength(2);
  });

  test("missing ngoName returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      title: "Test",
      questions: ["Q1"],
    });
    expect(res.status()).toBe(400);
  });

  test("missing title returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "Test",
      questions: ["Q1"],
    });
    expect(res.status()).toBe(400);
  });

  test("empty questions array returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "Test",
      title: "Test",
      questions: [],
    });
    expect(res.status()).toBe(400);
  });

  test("more than 50 questions returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "Test",
      title: "Test",
      questions: Array.from({ length: 51 }, (_, i) => `Q${i}`),
    });
    expect(res.status()).toBe(400);
  });

  test("too-long ngoName returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "A".repeat(256),
      title: "Test",
      questions: ["Q1"],
    });
    expect(res.status()).toBe(400);
  });

  test("invalid email returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "Test",
      ngoEmail: "bad-email",
      title: "Test",
      questions: ["Q1"],
    });
    expect(res.status()).toBe(400);
  });

  test("invalid logoUrl returns 400", async ({ request }) => {
    const { res } = await post(request, "/question-sets", {
      ngoName: "Test",
      title: "Test",
      logoUrl: "not-a-url",
      questions: ["Q1"],
    });
    expect(res.status()).toBe(400);
  });

  test("long question statement is silently skipped", async ({ request }) => {
    const { res, body } = await post(request, "/question-sets", {
      ngoName: "Test",
      title: `LongQ ${Date.now()}`,
      questions: ["Normal question", "A".repeat(501)],
    });
    expect(res.status()).toBe(201);
    // The too-long statement should be skipped
    expect(body.questions).toHaveLength(1);
  });
});

test.describe("UC-NGO-2: View approved question sets", () => {
  test("returns only approved sets", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "ViewNGO",
      title: `View ${Date.now()}`,
      questions: ["Testi"],
    });

    // Before approval, should not appear in public list
    let { body: before } = await get(request, "/question-sets");
    expect(before.find((s) => s.id === qs.id)).toBeUndefined();

    // After approval, should appear
    await approveQuestionSet(request, qs.id);
    let { body: after } = await get(request, "/question-sets");
    const found = after.find((s) => s.id === qs.id);
    expect(found).toBeDefined();
    expect(found.questions).toHaveLength(1);
  });

  test("rejected sets are not in public list", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "RejectedNGO",
      title: `Rejected ${Date.now()}`,
      questions: ["Testi"],
    });

    const { res } = await patch(
      request,
      `/admin/question-sets/${qs.id}/reject`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);

    const { body } = await get(request, "/question-sets");
    expect(body.find((s) => s.id === qs.id)).toBeUndefined();
  });
});
