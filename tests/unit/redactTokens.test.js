// Party, registration and candidate tokens are bearer secrets carried in API
// paths and magic-link query params. Whatever records a URL (Sentry events and
// breadcrumbs, access logs) must mask them (issue #36).
//
// The backend (CommonJS, built without the frontend) and the frontend (ES
// module) each have their own copy of the masking; every case runs against
// both so they can't drift apart.

const backend = require("../../src/redactTokens");

let frontend;
beforeAll(async () => {
  frontend = await import("../../vaalikone-frontend/src/redactTokens.js");
});

const T = "3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b3c4d5e6f7a8b";
const ID = "3b9d7c1e-5f2a-4e8b-9c6d-1a2b3c4d5e6f";

const implementations = [
  ["backend", () => backend],
  ["frontend", () => frontend],
];

describe.each(implementations)("redactTokens (%s)", (_name, impl) => {
  test.each([
    [`/api/candidates/me/${T}`, "/api/candidates/me/[token]"],
    [`/api/candidates/register/${T}`, "/api/candidates/register/[token]"],
    [`/api/candidates/party/${T}/candidates/${ID}/send-link`, `/api/candidates/party/[token]/candidates/${ID}/send-link`],
    [`/api/candidates/party/${T}/registration-token`, "/api/candidates/party/[token]/registration-token"],
    [`https://avoinvaalikone.fi/api/candidates/me/${T}?x=1`, "https://avoinvaalikone.fi/api/candidates/me/[token]?x=1"],
    // Express routes case-insensitively, so this reaches the same handler.
    [`/api/candidates/ME/${T}`, "/api/candidates/ME/[token]"],
    // Encoded by api.js's path helper.
    [`/api/candidates/me/${T}%20x`, "/api/candidates/me/[token]"],
    // Magic links (page URLs: Sentry's request URL and navigation breadcrumbs).
    [`https://avoinvaalikone.fi/?candidateToken=${T}`, "https://avoinvaalikone.fi/?candidateToken=[token]"],
    [`/?register=${T}#top`, "/?register=[token]#top"],
    [`/?view=candidate&partyToken=${T}&candidateId=${ID}`, `/?view=candidate&partyToken=[token]&candidateId=${ID}`],
    // Inside free text, such as a console breadcrumb or an error message.
    [`GET "/api/candidates/me/${T}" failed`, 'GET "/api/candidates/me/[token]" failed'],
    [`a /api/candidates/me/${T} b /api/candidates/party/${T}`, "a /api/candidates/me/[token] b /api/candidates/party/[token]"],
  ])("masks %s", (input, expected) => {
    expect(impl().redactTokens(input)).toBe(expected);
  });

  test.each([
    "/api/candidates",
    `/api/candidates/${ID}`,
    "/api/candidates?constituency=Lapin%20vaalipiiri",
    `/api/admin/parties/${ID}/token`,
    `/api/admin/parties/${ID}/candidates`,
    "/api/voter/match",
    "/?registered=1",
    "",
  ])("leaves %p alone", (input) => {
    expect(impl().redactTokens(input)).toBe(input);
  });

  test("redactTokensDeep masks every string in an event and leaves other values alone", () => {
    const event = {
      transaction: `GET /api/candidates/me/${T}`,
      request: { url: `http://localhost/api/candidates/me/${T}`, headers: { Referer: `https://x/?candidateToken=${T}` } },
      exception: { values: [{ type: "Error", value: `failed: /api/candidates/party/${T}` }] },
      breadcrumbs: [
        { category: "fetch", data: { method: "PUT", url: `/api/candidates/me/${T}`, status_code: 500 } },
        { category: "navigation", data: { from: `/?candidateToken=${T}`, to: "/" } },
      ],
      level: "error",
      fingerprint: null,
      extra: { ok: true, n: 3 },
    };
    const original = JSON.parse(JSON.stringify(event));

    const redacted = impl().redactTokensDeep(event);

    expect(JSON.stringify(redacted)).not.toContain(T);
    expect(redacted.request.url).toBe("http://localhost/api/candidates/me/[token]");
    expect(redacted.breadcrumbs[0].data).toEqual({ method: "PUT", url: "/api/candidates/me/[token]", status_code: 500 });
    expect(redacted.breadcrumbs[1].data.from).toBe("/?candidateToken=[token]");
    expect(redacted.level).toBe("error");
    expect(redacted.fingerprint).toBeNull();
    expect(redacted.extra).toEqual({ ok: true, n: 3 });
    // A copy: the SDK or the app may still hold the original objects.
    expect(event).toEqual(original);
  });

  test("redactTokensDeep survives a cycle", () => {
    const a = { url: `/api/candidates/me/${T}` };
    a.self = a;
    const redacted = impl().redactTokensDeep(a);
    expect(redacted.url).toBe("/api/candidates/me/[token]");
  });
});

// main.jsx passes these to Sentry.init.
describe("frontend Sentry hooks", () => {
  test("beforeBreadcrumb masks a fetch breadcrumb's URL", () => {
    const crumb = frontend.sentryRedaction.beforeBreadcrumb({
      type: "http", category: "fetch", data: { method: "GET", url: `/api/candidates/register/${T}`, status_code: 404 },
    });
    expect(crumb.data.url).toBe("/api/candidates/register/[token]");
  });

  // The app scrubs the token from the address bar with history.replaceState,
  // which Sentry records as a navigation from the magic link.
  test("beforeBreadcrumb masks a navigation breadcrumb from a magic link", () => {
    const crumb = frontend.sentryRedaction.beforeBreadcrumb({
      category: "navigation", data: { from: `/?partyToken=${T}`, to: "/" },
    });
    expect(crumb.data).toEqual({ from: "/?partyToken=[token]", to: "/" });
  });

  test("beforeSend masks the event", () => {
    const event = frontend.sentryRedaction.beforeSend({ request: { url: `https://x/?candidateToken=${T}` } });
    expect(event.request.url).toBe("https://x/?candidateToken=[token]");
  });
});
