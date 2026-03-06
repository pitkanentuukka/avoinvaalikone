/**
 * Shared helpers for E2E tests.
 *
 * All API helpers use Playwright's request context and talk directly
 * to the backend at http://localhost:3000.
 *
 * Backend expects camelCase request bodies but returns snake_case from DB.
 */

require("dotenv").config();

const ADMIN_SECRET = process.env.ADMIN_SECRET || "password";
const API = "http://localhost:3000/api";

/** Headers for admin-authenticated requests. */
function adminHeaders() {
  return { Authorization: `Bearer ${ADMIN_SECRET}` };
}

/** POST JSON and return parsed body. */
async function post(request, path, body, headers = {}) {
  const res = await request.post(`${API}${path}`, {
    data: body,
    headers: { "Content-Type": "application/json", ...headers },
  });
  return { res, body: await res.json() };
}

/** GET and return parsed body. */
async function get(request, path, headers = {}) {
  const res = await request.get(`${API}${path}`, { headers });
  return { res, body: await res.json() };
}

/** PATCH and return parsed body. */
async function patch(request, path, headers = {}) {
  const res = await request.patch(`${API}${path}`, { headers });
  return { res, body: await res.json() };
}

/** DELETE and return parsed body. */
async function del(request, path, headers = {}) {
  const res = await request.delete(`${API}${path}`, { headers });
  return { res, body: await res.json() };
}

/** PUT JSON and return parsed body. */
async function put(request, path, body, headers = {}) {
  const res = await request.put(`${API}${path}`, {
    data: body,
    headers: { "Content-Type": "application/json", ...headers },
  });
  return { res, body: await res.json() };
}

// ─── Composite helpers ───

/** Create a party via admin API. Returns the party object (snake_case keys). */
async function createParty(request, name, email) {
  const { body } = await post(
    request,
    "/admin/parties",
    { name, email: email || null },
    adminHeaders()
  );
  return body;
}

/**
 * Submit a question set via public API. Returns the created set (snake_case keys).
 * Backend expects camelCase body: { ngoName, ngoEmail, logoUrl, title, questions }
 */
async function submitQuestionSet(request, { ngoName, title, questions, ngoEmail, logoUrl }) {
  const { body } = await post(request, "/question-sets", {
    ngoName,
    ngoEmail: ngoEmail || null,
    logoUrl: logoUrl || null,
    title,
    questions: questions.map((q) => (typeof q === "string" ? q : q)),
  });
  return body;
}

/** Approve a question set via admin API. */
async function approveQuestionSet(request, id) {
  const { body } = await patch(
    request,
    `/admin/question-sets/${id}/approve`,
    adminHeaders()
  );
  return body;
}

/**
 * Register a candidate via party token. Returns candidate object (snake_case keys).
 * Backend expects camelCase body: { name, photoUrl, bio, email }
 */
async function createCandidate(request, partyToken, { name, email, photoUrl, bio }) {
  const { body } = await post(request, `/candidates/party/${partyToken}`, {
    name,
    email: email || null,
    photoUrl: photoUrl || null,
    bio: bio || null,
  });
  return body;
}

/** Save candidate answers via party token. */
async function saveAnswers(request, partyToken, candidateId, answers) {
  const { body } = await put(
    request,
    `/candidates/party/${partyToken}/candidates/${candidateId}/answers`,
    { answers }
  );
  return body;
}

/**
 * Run voter match. Returns { session_id, results } (snake_case from backend).
 * Backend expects camelCase body: { answers, weights, questionSetIds }
 */
async function voterMatch(request, { answers, weights, questionSetIds }) {
  const { body } = await post(request, "/voter/match", {
    answers,
    weights: weights || {},
    questionSetIds: questionSetIds || undefined,
  });
  return body;
}

/**
 * Full setup: creates a party, submits + approves a question set,
 * registers a candidate, and saves their answers.
 * Returns { party, questionSet, candidate, questions }.
 *
 * Note: response keys are snake_case from the backend.
 */
async function fullSetup(request, opts = {}) {
  const partyName = opts.partyName || `Testipuolue ${Date.now()}`;
  const party = await createParty(request, partyName, "party@test.fi");

  const qs = await submitQuestionSet(request, {
    ngoName: opts.ngoName || "Testijärjestö",
    title: opts.title || "Testikysymykset",
    questions: opts.questions || [
      "Suomen tulee lisätä puolustusmenoja",
      "Julkista terveydenhuoltoa tulee vahvistaa",
      "Ilmastotoimia tulee kiristää",
    ],
  });
  await approveQuestionSet(request, qs.id);

  const questions = qs.questions;
  const candidateName = opts.candidateName || "Testi Ehdokas";
  const candidate = await createCandidate(request, party.token, {
    name: candidateName,
    email: "candidate@test.fi",
  });

  const answerValues = opts.answerValues || [4, 2, 0];
  const answerMap = {};
  questions.forEach((q, i) => {
    answerMap[q.id] = { value: answerValues[i % answerValues.length], explanation: "" };
  });
  await saveAnswers(request, party.token, candidate.id, answerMap);

  return { party, questionSet: qs, candidate, questions };
}

module.exports = {
  ADMIN_SECRET,
  API,
  adminHeaders,
  post,
  get,
  patch,
  del,
  put,
  createParty,
  submitQuestionSet,
  approveQuestionSet,
  createCandidate,
  saveAnswers,
  voterMatch,
  fullSetup,
};
