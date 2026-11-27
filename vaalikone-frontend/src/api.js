// API client for the backend. Kept free of Vite-only syntax (import.meta.env,
// ?raw imports) so the unit tests can import it under Node.
import translations from "./translations.js";

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function mapKeys(obj, fn) {
  if (Array.isArray(obj)) return obj.map((item) => mapKeys(item, fn));
  if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [fn(k), mapKeys(v, fn)])
    );
  }
  return obj;
}

const toCamel = (data) => mapKeys(data, snakeToCamel);

// Builds an API path with each interpolated value (a token or an id) encoded
// as one path segment. Unencoded, the browser would resolve the URL before
// sending it: `..` climbs a level, `#` cuts the path short.
//
// Encoding isn't enough for dot segments: `.` and `..` survive it, browsers
// resolve them even as %2E, and nginx picks its location after decoding %2F,
// so enough `..` parts climb out of /api/ and get index.html. An empty value merges two
// segments. No real token or id is any of these, so such a value (or one that
// can't be encoded, a lone surrogate) gives null and apiFetch refuses it as an
// invalid link. Returning null rather than throwing keeps the refusal a
// rejected promise.
function path(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const value = String(values[i]);
    if (value === "" || value.split("/").some((part) => part === "." || part === "..")) return null;
    try {
      out += encodeURIComponent(value) + strings[i + 1];
    } catch {
      return null;
    }
  }
  return out;
}

// A failure that may pass: a network error or any HTTP error but 404 (the
// token routes' answer to an unknown token), 400 (a malformed one), and
// 414/431 (nginx/Node rejecting an overlong token request). A 403
// can come from Cloudflare rather than the app. The token views offer a retry
// for these and show "invalid link" for anything else.
export function isTransientError(err) {
  return err?.network === true || (err?.status !== undefined && ![400, 404, 414, 431].includes(err.status));
}

// The text a view shows for a failed request, in the viewer's language `t`
// (#211). Only the app's own messages (a JSON `error`, in Finnish) are shown
// as they are: a network failure's would be the browser's English ("Failed to
// fetch"), and a response without one has only a placeholder. Errors that
// didn't come from a response keep their message.
export function errorText(err, t) {
  if (err?.network) return t.networkError;
  if (err?.status !== undefined && !err.serverMessage) return t.requestFailed(err.status);
  return err?.message;
}

// The network and placeholder messages, for anything that shows one without
// errorText, are in Finnish like the rest of the UI.
const fi = translations.fi;

// The request never got a usable answer: fetch failed or the body couldn't be
// read. The browser's own error stays as `cause`.
function networkError(cause) {
  const err = new Error(fi.networkError, { cause });
  err.network = true;
  return err;
}

// `fetch` and `retryDelayMs` are injectable for the unit tests.
export function createApi({
  base,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  retryDelayMs = 1000,
}) {
  // One retry on transient upstream errors (rolling deploy restarting a
  // replica), for GETs and for requests that pass `retry: true` because a
  // repeat is harmless. Any other request may already have taken effect when
  // its response was lost, so a retry could repeat its side effect.
  async function apiFetch(urlPath, options = {}) {
    if (urlPath === null) throw new Error("Virheellinen linkki"); // no status: not transient
    const { body, adminSecret, retry, ...rest } = options;
    const retryable = retry ?? (rest.method ?? "GET").toUpperCase() === "GET";
    const headers = { "Content-Type": "application/json", ...rest.headers };
    if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;
    const doFetch = () =>
      fetchImpl(`${base}${urlPath}`, {
        ...rest,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }).catch((err) => {
        throw networkError(err);
      });
    let res;
    try {
      res = await doFetch();
    } catch (err) {
      if (!retryable) throw err;
    }
    if (retryable && (!res || [502, 503, 504].includes(res.status))) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      res = await doFetch(); // a failure here is final: at most one retry
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      // The message is the app's own (a JSON `error`), not a placeholder for
      // a body that wasn't one (a proxy's HTML page, say).
      const serverMessage = typeof data?.error === "string" && data.error !== "";
      const err = new Error(serverMessage ? data.error : fi.requestFailed(res.status));
      err.status = res.status;
      err.serverMessage = serverMessage;
      throw err;
    }
    if (res.status === 204) return null;
    let data;
    try {
      data = await res.json();
    } catch (err) {
      // The connection dropped mid-body, or something in between (a captive
      // portal) answered with a non-JSON page.
      throw networkError(err);
    }
    return toCamel(data);
  }

  return {
    // Public
    getQuestionSets: () => apiFetch("/question-sets"),
    getCandidates: () => apiFetch("/candidates"),
    getCandidate: (id) => apiFetch(path`/candidates/${id}`),
    submitQuestionSet: (data) => apiFetch("/question-sets", { method: "POST", body: data }),
    // Retryable because each submission gets its own sessionId and the retry
    // reuses it: the research insert is ON CONFLICT DO NOTHING on
    // (session_id, question_id), so a retry after a lost response stores
    // nothing new. crypto.randomUUID is missing outside secure contexts
    // (plain-HTTP non-localhost); the server then picks the id and the
    // request isn't retried. The voter view always passes its submission's
    // sessionId (src/voterMatch.js), so the voter's own retry of a failed
    // match reuses it too; the default serves other callers.
    voterMatch: (data, { sessionId = globalThis.crypto?.randomUUID?.() } = {}) => {
      return apiFetch("/voter/match", {
        method: "POST",
        body: { ...data, sessionId },
        retry: Boolean(sessionId),
      });
    },

    // Party-token gated (secretary's management access)
    getPartyOverview: (token) => apiFetch(path`/candidates/party/${token}`),
    rotateRegistrationLink: (token) =>
      apiFetch(path`/candidates/party/${token}/registration-token`, { method: "POST" }),
    sendCandidateLink: (token, id) =>
      apiFetch(path`/candidates/party/${token}/candidates/${id}/send-link`, { method: "POST" }),
    // Revokes the old link and emails the new one; the party never sees it.
    // expectedEmail: the address the user was shown; the server refuses (409)
    // if it has changed since, since the new link would go somewhere else.
    rotateCandidateLink: (token, id, expectedEmail) =>
      apiFetch(path`/candidates/party/${token}/candidates/${id}/token`, { method: "POST", body: { expectedEmail } }),
    removeCandidate: (token, id) =>
      apiFetch(path`/candidates/party/${token}/candidates/${id}`, { method: "DELETE" }),

    // Registration-link gated
    getRegistration: (token) => apiFetch(path`/candidates/register/${token}`),
    register: (token, data) =>
      apiFetch(path`/candidates/register/${token}`, { method: "POST", body: data }),

    // Candidate-token gated (the candidate's personal link)
    getOwnProfile: (token) => apiFetch(path`/candidates/me/${token}`),
    // One request, so the server saves the profile and the answers together
    // or neither: a rejected answer must not leave the profile change stored.
    // A backend that predates the combined save ignores `answers` and replies
    // without `saved`; that is an error (answersIgnored), not a success.
    saveOwnProfile: async (token, profile, answers) => {
      const result = await apiFetch(path`/candidates/me/${token}`, { method: "PUT", body: { ...profile, answers } });
      if (typeof result?.saved !== "number") {
        throw Object.assign(new Error("Answers were not saved"), { answersIgnored: true });
      }
      return result;
    },

    // Admin
    getParties: (secret) => apiFetch("/admin/parties", { adminSecret: secret }),
    createParty: (secret, data) =>
      apiFetch("/admin/parties", { method: "POST", body: data, adminSecret: secret }),
    deleteParty: (secret, id) =>
      apiFetch(path`/admin/parties/${id}`, { method: "DELETE", adminSecret: secret }),
    rotatePartyToken: (secret, id) =>
      apiFetch(path`/admin/parties/${id}/token`, { method: "POST", adminSecret: secret }),
    getPartyCandidatesAdmin: (secret, id) =>
      apiFetch(path`/admin/parties/${id}/candidates`, { adminSecret: secret }),
    sendPartyCandidateLinks: (secret, id) =>
      apiFetch(path`/admin/parties/${id}/send-candidate-links`, { method: "POST", adminSecret: secret }),
    // No address is sent as "": undefined would be dropped from the JSON, and
    // the server would then skip the check.
    rotateCandidateTokenAdmin: (secret, partyId, id, expectedEmail) =>
      apiFetch(path`/admin/parties/${partyId}/candidates/${id}/token`, {
        method: "POST",
        body: { expectedEmail: expectedEmail ?? "" },
        adminSecret: secret,
      }),
    rotatePartyCandidateTokens: (secret, id) =>
      apiFetch(path`/admin/parties/${id}/candidate-tokens`, { method: "POST", adminSecret: secret }),
    getAllQuestionSets: (secret) => apiFetch("/admin/question-sets", { adminSecret: secret }),
    approveQuestionSet: (secret, id) =>
      apiFetch(path`/admin/question-sets/${id}/approve`, { method: "PATCH", adminSecret: secret }),
    rejectQuestionSet: (secret, id) =>
      apiFetch(path`/admin/question-sets/${id}/reject`, { method: "PATCH", adminSecret: secret }),
    hideQuestionSet: (secret, id) =>
      apiFetch(path`/admin/question-sets/${id}/hide`, { method: "PATCH", adminSecret: secret }),
    unhideQuestionSet: (secret, id) =>
      apiFetch(path`/admin/question-sets/${id}/unhide`, { method: "PATCH", adminSecret: secret }),
    deleteQuestionSet: (secret, id) =>
      apiFetch(path`/admin/question-sets/${id}`, { method: "DELETE", adminSecret: secret }),
    reviewQuestionSet: (secret, id, data) =>
      apiFetch(path`/admin/question-sets/${id}/review`, { method: "PATCH", body: data, adminSecret: secret }),
    addQuestion: (secret, setId, statement) =>
      apiFetch(path`/admin/question-sets/${setId}/questions`, { method: "POST", body: { statement }, adminSecret: secret }),
    removeQuestion: (secret, setId, questionId) =>
      apiFetch(path`/admin/question-sets/${setId}/questions/${questionId}`, { method: "DELETE", adminSecret: secret }),
    mergeQuestions: (secret, keepId, dropIds) =>
      apiFetch("/admin/question-sets/merge-questions", { method: "POST", body: { keepId, dropIds }, adminSecret: secret }),
  };
}
