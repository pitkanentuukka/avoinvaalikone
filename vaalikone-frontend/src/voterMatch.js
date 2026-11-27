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
//
// `previous` is the last failed submission: if the voter went back to
// weighting and asks for the results again without changing anything, it is
// the same session, which an earlier attempt may already have stored.
// Anything changed gets a new session; under the old id the server would keep
// the old answers. (Changes that don't change the meaning, such as clicking
// the already-highlighted default weight, also count as changed: a new
// session is the safe side.) After a success there is no previous: Start
// over keeps the sets and the research choice, so the next voter on a shared
// computer may send the same payload, and must be a session of their own.
// A changed submission can't take back an earlier attempt the server did
// store (say the voter opts out of research after a lost response): the
// server never deletes research rows.
export function newMatchSubmission(payload, previous = null) {
  // A copy, so a retry sends what the first attempt did. Plain JSON;
  // structuredClone would leave out Safari before 15.4.
  const json = JSON.stringify(payload);
  if (previous && JSON.stringify(previous.payload) === json) return previous;
  return { payload: JSON.parse(json), sessionId: globalThis.crypto?.randomUUID?.() };
}

// The step to show after one attempt, and what it shows. A failure has a
// step of its own: the results screen would read as "no candidates matched"
// and its Start over would throw the answers away.
//
// The failure step explains itself; the error is shown only when it is the
// app's own message (a JSON `error` on a 4xx, e.g. the rate limit's). A
// network failure's generic "check your connection" would repeat the step's
// own text, and a 5xx ("HTTP 503") or a proxy's HTML error page ("Server
// error") would be technical English in the Finnish UI.
export async function runMatch(api, { payload, sessionId }) {
  try {
    const { results, questionCount } = await api.voterMatch(payload, { sessionId });
    return { step: "results", results: results ?? [], questionCount: questionCount ?? 0, error: null };
  } catch (e) {
    const own = e.serverMessage && e.status >= 400 && e.status < 500;
    return { step: "match-failed", error: own ? e.message : null };
  }
}
