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

// `fetch` and `retryDelayMs` are injectable for the unit tests.
export function createApi({
  base,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  retryDelayMs = 1000,
}) {
  async function apiFetch(path, options = {}) {
    const { body, adminSecret, ...rest } = options;
    const headers = { "Content-Type": "application/json", ...rest.headers };
    if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;
    const doFetch = () =>
      fetchImpl(`${base}${path}`, {
        ...rest,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    let res;
    try {
      res = await doFetch();
      // One retry on transient upstream errors (rolling deploy restarting a
      // replica). Safe for the match POST too: its insert is ON CONFLICT DO
      // NOTHING, so a duplicate submission is a no-op server-side.
      if ([502, 503, 504].includes(res.status)) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        res = await doFetch();
      }
    } catch {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      res = await doFetch();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Server error" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    const data = await res.json();
    return toCamel(data);
  }

  return {
    // Public
    getQuestionSets: () => apiFetch("/question-sets"),
    getCandidates: () => apiFetch("/candidates"),
    getCandidate: (id) => apiFetch(`/candidates/${id}`),
    submitQuestionSet: (data) => apiFetch("/question-sets", { method: "POST", body: data }),
    voterMatch: (data) => apiFetch("/voter/match", { method: "POST", body: data }),

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
    updateOwnProfile: (token, data) =>
      apiFetch(`/candidates/me/${token}`, { method: "PUT", body: data }),
    saveOwnAnswers: (token, answers) =>
      apiFetch(`/candidates/me/${token}/answers`, { method: "PUT", body: { answers } }),

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
