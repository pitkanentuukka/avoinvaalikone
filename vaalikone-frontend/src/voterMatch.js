// The voter's match request (issue #153). Kept free of Vite-only syntax so
// the unit tests can import it (tests/unit/voterMatch.test.js).
//
// A submission is everything the request sends: answers, weights, selected
// sets, constituency, research choice, and a sessionId. A retry resends the
// same submission, so the voter neither re-answers nor has their research
// choice reset, and the server's research insert (ON CONFLICT DO NOTHING on
// session_id, question_id) stores nothing new if an earlier attempt's
// response was only lost. crypto.randomUUID is missing outside secure
// contexts; the server then picks the id on each attempt.
export function newMatchSubmission(payload) {
  return {
    // A copy, so the retry sends what the first attempt did. Plain JSON;
    // structuredClone would leave out Safari before 15.4.
    payload: JSON.parse(JSON.stringify(payload)),
    sessionId: globalThis.crypto?.randomUUID?.(),
  };
}

// The step to show after one attempt, and what it shows. A failure has a
// step of its own: the results screen would read as "no candidates matched"
// and its Start over would throw the answers away.
export async function runMatch(api, { payload, sessionId }) {
  try {
    const { results, questionCount } = await api.voterMatch(payload, { sessionId });
    return { step: "results", results: results ?? [], questionCount: questionCount ?? 0, error: null };
  } catch (e) {
    return { step: "match-failed", error: e.message };
  }
}
