// API client for the backend. Kept free of Vite-only syntax (import.meta.env,
// ?raw imports) so the unit tests can import it under Node.
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
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
const _toSnake = (data) => mapKeys(data, camelToSnake);

// A failure that may pass: a network error or any HTTP error but 404 (the
// token routes' answer to an unknown token) and 400 (a malformed one). A 403
// can come from Cloudflare rather than the app. The token views offer a retry
// for these and show "invalid link" for anything else.
export function isTransientError(err) {
  return err?.network === true || (err?.status !== undefined && ![400, 404].includes(err.status));
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
  async function apiFetch(path, options = {}) {
    const { body, adminSecret, retry, ...rest } = options;
    const retryable = retry ?? (rest.method ?? "GET").toUpperCase() === "GET";
    const headers = { "Content-Type": "application/json", ...rest.headers };
    if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;
    const doFetch = () =>
      fetchImpl(`${base}${path}`, {
        ...rest,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }).catch((err) => {
        err.network = true;
        throw err;
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
      const data = await res.json().catch(() => ({ error: "Server error" }));
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    let data;
    try {
      data = await res.json();
    } catch (err) {
      // The connection dropped mid-body, or something in between (a captive
      // portal) answered with a non-JSON page.
      err.network = true;
      throw err;
    }
    return toCamel(data);
  }

  return {
    // Public
    getQuestionSets: () => apiFetch("/question-sets"),
    getCandidates: () => apiFetch("/candidates"),
    getCandidate: (id) => apiFetch(`/candidates/${id}`),
    submitQuestionSet: (data) => apiFetch("/question-sets", { method: "POST", body: data }),
    // Retryable because each submission gets its own sessionId and the retry
    // reuses it: the research insert is ON CONFLICT DO NOTHING on
    // (session_id, question_id), so a retry after a lost response stores
    // nothing new. crypto.randomUUID is missing outside secure contexts
    // (plain-HTTP non-localhost); the server then picks the id and the
    // request isn't retried.
    voterMatch: (data) => {
      const sessionId = globalThis.crypto?.randomUUID?.();
      return apiFetch("/voter/match", {
        method: "POST",
        body: { ...data, sessionId },
        retry: Boolean(sessionId),
      });
    },

    // Party-token gated (secretary's management access)
    getPartyOverview: (token) => apiFetch(`/candidates/party/${token}`),
    rotateRegistrationLink: (token) =>
      apiFetch(`/candidates/party/${token}/registration-token`, { method: "POST" }),
    sendCandidateLink: (token, id) =>
      apiFetch(`/candidates/party/${token}/candidates/${id}/send-link`, { method: "POST" }),
    removeCandidate: (token, id) =>
      apiFetch(`/candidates/party/${token}/candidates/${id}`, { method: "DELETE" }),

    // Registration-link gated
    getRegistration: (token) => apiFetch(`/candidates/register/${token}`),
    register: (token, data) =>
      apiFetch(`/candidates/register/${token}`, { method: "POST", body: data }),

    // Candidate-token gated (the candidate's personal link)
    getOwnProfile: (token) => apiFetch(`/candidates/me/${token}`),
    // One request, so the server saves the profile and the answers together
    // or neither: a rejected answer must not leave the profile change stored.
    saveOwnProfile: (token, profile, answers) =>
      apiFetch(`/candidates/me/${token}`, { method: "PUT", body: { ...profile, answers } }),

    // Admin
    getParties: (secret) => apiFetch("/admin/parties", { adminSecret: secret }),
    createParty: (secret, data) =>
      apiFetch("/admin/parties", { method: "POST", body: data, adminSecret: secret }),
    deleteParty: (secret, id) =>
      apiFetch(`/admin/parties/${id}`, { method: "DELETE", adminSecret: secret }),
    rotatePartyToken: (secret, id) =>
      apiFetch(`/admin/parties/${id}/token`, { method: "POST", adminSecret: secret }),
    getPartyCandidatesAdmin: (secret, id) =>
      apiFetch(`/admin/parties/${id}/candidates`, { adminSecret: secret }),
    sendPartyCandidateLinks: (secret, id) =>
      apiFetch(`/admin/parties/${id}/send-candidate-links`, { method: "POST", adminSecret: secret }),
    getAllQuestionSets: (secret) => apiFetch("/admin/question-sets", { adminSecret: secret }),
    approveQuestionSet: (secret, id) =>
      apiFetch(`/admin/question-sets/${id}/approve`, { method: "PATCH", adminSecret: secret }),
    rejectQuestionSet: (secret, id) =>
      apiFetch(`/admin/question-sets/${id}/reject`, { method: "PATCH", adminSecret: secret }),
    hideQuestionSet: (secret, id) =>
      apiFetch(`/admin/question-sets/${id}/hide`, { method: "PATCH", adminSecret: secret }),
    unhideQuestionSet: (secret, id) =>
      apiFetch(`/admin/question-sets/${id}/unhide`, { method: "PATCH", adminSecret: secret }),
    deleteQuestionSet: (secret, id) =>
      apiFetch(`/admin/question-sets/${id}`, { method: "DELETE", adminSecret: secret }),
    reviewQuestionSet: (secret, id, data) =>
      apiFetch(`/admin/question-sets/${id}/review`, { method: "PATCH", body: data, adminSecret: secret }),
    addQuestion: (secret, setId, statement) =>
      apiFetch(`/admin/question-sets/${setId}/questions`, { method: "POST", body: { statement }, adminSecret: secret }),
    removeQuestion: (secret, setId, questionId) =>
      apiFetch(`/admin/question-sets/${setId}/questions/${questionId}`, { method: "DELETE", adminSecret: secret }),
    mergeQuestions: (secret, keepId, dropIds) =>
      apiFetch("/admin/question-sets/merge-questions", { method: "POST", body: { keepId, dropIds }, adminSecret: secret }),
  };
}
