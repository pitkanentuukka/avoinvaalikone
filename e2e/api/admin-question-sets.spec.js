// @ts-check
const { test, expect } = require("@playwright/test");
const {
  adminHeaders,
  get,
  patch,
  submitQuestionSet,
  approveQuestionSet,
} = require("../helpers");

test.describe("UC-ADMIN: Question set management", () => {
  test("UC-ADMIN-4: list all question sets (any status)", async ({ request }) => {
    // Submit one so there is at least one
    await submitQuestionSet(request, {
      ngoName: "ListausNGO",
      title: `Listaus ${Date.now()}`,
      questions: ["Testi väittämä 1"],
    });

    const { res, body } = await get(
      request,
      "/admin/question-sets",
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Should include questions array
    expect(body[0].questions).toBeDefined();
  });

  test("UC-ADMIN-5: approve a question set", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "ApproveNGO",
      title: `Approve ${Date.now()}`,
      questions: ["Väittämä A"],
    });
    expect(qs.status).toBe("pending");

    const { res, body } = await patch(
      request,
      `/admin/question-sets/${qs.id}/approve`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.reviewed_at).toBeTruthy();
  });

  test("UC-ADMIN-6: reject a question set", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "RejectNGO",
      title: `Reject ${Date.now()}`,
      questions: ["Väittämä B"],
    });

    const { res, body } = await patch(
      request,
      `/admin/question-sets/${qs.id}/reject`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(body.status).toBe("rejected");
    expect(body.reviewed_at).toBeTruthy();
  });

  test("approving already approved set is idempotent", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "IdempotentNGO",
      title: `Idempotent ${Date.now()}`,
      questions: ["Väittämä C"],
    });
    await approveQuestionSet(request, qs.id);

    // Approve again
    const { res, body } = await patch(
      request,
      `/admin/question-sets/${qs.id}/approve`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(body.status).toBe("approved");
  });

  test("rejecting an approved set changes status", async ({ request }) => {
    const qs = await submitQuestionSet(request, {
      ngoName: "FlipNGO",
      title: `Flip ${Date.now()}`,
      questions: ["Väittämä D"],
    });
    await approveQuestionSet(request, qs.id);

    const { res, body } = await patch(
      request,
      `/admin/question-sets/${qs.id}/reject`,
      adminHeaders()
    );
    expect(res.status()).toBe(200);
    expect(body.status).toBe("rejected");
  });

  test("approve non-existent question set returns 404", async ({ request }) => {
    const { res } = await patch(
      request,
      "/admin/question-sets/00000000-0000-0000-0000-000000000000/approve",
      adminHeaders()
    );
    expect(res.status()).toBe(404);
  });

  test("reject non-existent question set returns 404", async ({ request }) => {
    const { res } = await patch(
      request,
      "/admin/question-sets/00000000-0000-0000-0000-000000000000/reject",
      adminHeaders()
    );
    expect(res.status()).toBe(404);
  });

  test("admin question set list ordered: pending first", async ({ request }) => {
    const ts = Date.now();
    const pending = await submitQuestionSet(request, {
      ngoName: "OrderNGO",
      title: `Pending ${ts}`,
      questions: ["V1"],
    });
    const approved = await submitQuestionSet(request, {
      ngoName: "OrderNGO",
      title: `Approved ${ts}`,
      questions: ["V2"],
    });
    await approveQuestionSet(request, approved.id);

    const { body } = await get(
      request,
      "/admin/question-sets",
      adminHeaders()
    );
    const pendingIdx = body.findIndex((s) => s.id === pending.id);
    const approvedIdx = body.findIndex((s) => s.id === approved.id);
    expect(pendingIdx).toBeLessThan(approvedIdx);
  });
});
