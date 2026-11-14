const { Router } = require("express");
const { randomUUID } = require("crypto");
const db = require("../db/pool");
const { isValidUUID, validateUUIDArray, isValidRange } = require("../middleware/validation");
const { weightFor, scoreCandidate, compareResults } = require("../match");

const router = Router();

/**
 * POST /api/voter/match
 *
 * Body:
 * {
 *   answers: { [questionId]: value (0-4) },
 *   weights: { [questionId]: weight (0-3) },   // optional, missing → DEFAULT_WEIGHT
 *   questionSetIds: ["uuid", ...],              // optional filter
 *   sessionId: "uuid"                           // optional, see below
 * }
 *
 * sessionId keys the anonymous research rows. The frontend generates one per
 * submission and resends it when it retries after a transient upstream error,
 * so the retry's insert conflicts and stores no second session. Without one,
 * the server generates it.
 *
 * Returns { sessionId, questionCount, results }: candidates ranked by match
 * percentage. questionCount is how many of the voter's questions were scored;
 * each result's answeredCount is how many of those the candidate answered.
 * sessionId is null when includeInResearch is false or none of the voter's
 * questions were scored; otherwise it is set even if no candidate matched.
 *
 * A research session records the questionnaire that was matched: only the
 * scored questions are stored, not answers kept from deselected sets.
 */
router.post("/match", async (req, res, next) => {
  try {
    const {
      answers,
      questionSetIds,
      constituency,
      includeInResearch = true,
      sessionId: clientSessionId,
    } = req.body;
    // A destructuring default would let null through. Like the other optional
    // fields here, null means "not given".
    const weights = req.body.weights ?? {};

    if (!answers || typeof answers !== "object" || Object.keys(answers).length === 0) {
      return res.status(400).json({ error: "Vastaukset vaaditaan" });
    }

    const allQuestionIds = Object.keys(answers);

    // Validate all question IDs are valid UUIDs
    if (!allQuestionIds.every(id => isValidUUID(id))) {
      return res.status(400).json({ error: "Virheelliset kysymyksen tunnisteet" });
    }

    // Validate all answer values are in range
    for (const value of Object.values(answers)) {
      if (!isValidRange(value, 0, 4)) {
        return res.status(400).json({ error: "Vastaus-arvot tulee olla 0-4" });
      }
    }

    if (typeof weights !== "object" || Array.isArray(weights)) {
      return res.status(400).json({ error: "Virheelliset painoarvot" });
    }

    // Validate all weight values are in range (0-3) if provided
    for (const [qId, w] of Object.entries(weights)) {
      if (!isValidUUID(qId) || !isValidRange(w, 0, 3)) {
        return res.status(400).json({ error: "Painoarvojen tulee olla 0-3" });
      }
    }

    // Validate question set IDs if provided
    if (Array.isArray(questionSetIds) && questionSetIds.length > 0) {
      if (!validateUUIDArray(questionSetIds)) {
        return res.status(400).json({ error: "Virheelliset kysymyssarjan tunnisteet" });
      }
    }

    // Validate constituency if provided
    if (constituency !== undefined && constituency !== null) {
      if (typeof constituency !== "string" || constituency.length > 255) {
        return res.status(400).json({ error: "Virheellinen vaalipiiri" });
      }
    }

    if (clientSessionId !== undefined && clientSessionId !== null && !isValidUUID(clientSessionId)) {
      return res.status(400).json({ error: "Virheellinen istunnon tunniste" });
    }

    // Keep only answers for questions that still exist. Voter answers are stored
    // in browser localStorage, so they can reference questions that have since
    // been merged or deleted; those must not reach the match computation or
    // the voter_responses insert (FK violation).
    //
    // The same query flags which of them belong to the selected sets. A question
    // can belong to several sets, so membership is tested with EXISTS against the
    // join table rather than a column on questions (which avoids duplicate rows
    // when a question is shared by multiple selected sets). Only those questions
    // are scored: localStorage also keeps answers to sets the voter has since
    // deselected, and every question scored counts against candidates who
    // skipped it. For the same reason they are left out of the research
    // session.
    const hasSetFilter = Array.isArray(questionSetIds) && questionSetIds.length > 0;
    const { rows: existingRows } = hasSetFilter
      ? await db.query(
          `SELECT q.id, EXISTS (
             SELECT 1 FROM question_set_questions qsq
             WHERE qsq.question_id = q.id AND qsq.question_set_id = ANY($2)
           ) AS in_selected_sets
           FROM questions q WHERE q.id = ANY($1) ORDER BY q.id`,
          [allQuestionIds, questionSetIds]
        )
      : await db.query("SELECT id FROM questions WHERE id = ANY($1) ORDER BY id", [allQuestionIds]);
    const voterQuestionIds = existingRows.map((r) => r.id);
    if (voterQuestionIds.length === 0) {
      return res.json({ sessionId: null, questionCount: 0, results: [] });
    }
    // The DB returns IDs in lowercase; an answer sent under another spelling of
    // the key has no value here and is left out of scoring (and questionCount).
    const scoredQuestionIds = (hasSetFilter
      ? existingRows.filter((r) => r.in_selected_sets).map((r) => r.id)
      : voterQuestionIds
    ).filter((id) => answers[id] !== undefined);

    const params = [scoredQuestionIds];

    // Optionally filter by constituency
    let constituencyFilter = "";
    if (constituency) {
      params.push(constituency);
      constituencyFilter = `AND c.constituency = $${params.length}`;
    }

    // Fetch all candidate answers for the relevant questions. Explanations are
    // deliberately not selected: they dominate the response size (free text ×
    // questions × candidates) and the UI lazy-loads them per candidate via
    // GET /api/candidates/:id when a result card is expanded.
    const { rows: candidateAnswers } = await db.query(
      `SELECT ca.candidate_id, ca.question_id, ca.value
       FROM candidate_answers ca
       JOIN candidates c ON c.id = ca.candidate_id
       WHERE ca.question_id = ANY($1)
       ${constituencyFilter}`,
      params
    );

    // Fetch candidate info. With no candidate answers (early in an election, or
    // a narrow constituency filter) there is nothing to rank, but the voter
    // still answered: fall through so the session is recorded for research and
    // the response keeps its usual shape.
    const candidateIds = [...new Set(candidateAnswers.map((a) => a.candidate_id))];
    const { rows: candidates } = candidateIds.length === 0
      ? { rows: [] }
      : await db.query(
          `SELECT c.id, c.name, c.photo_url, c.bio, c.constituency,
                  p.id AS party_id, p.name AS party_name
           FROM candidates c
           JOIN parties p ON p.id = c.party_id
           WHERE c.id = ANY($1)`,
          [candidateIds]
        );

    // Group answers by candidate
    const answersByCandidate = {};
    candidateAnswers.forEach((a) => {
      if (!answersByCandidate[a.candidate_id]) answersByCandidate[a.candidate_id] = {};
      answersByCandidate[a.candidate_id][a.question_id] = {
        value: a.value,
      };
    });

    // Compute match scores
    const results = candidates.map((c) => {
      const cAnswers = answersByCandidate[c.id] || {};
      const { match, answeredCount } = scoreCandidate(answers, weights, scoredQuestionIds, cAnswers);

      return {
        id: c.id,
        name: c.name,
        photoUrl: c.photo_url,
        bio: c.bio,
        constituency: c.constituency,
        partyId: c.party_id,
        partyName: c.party_name,
        match,
        answeredCount,
        answers: cAnswers,
      };
    });

    results.sort(compareResults);

    let sessionId = null;
    if (includeInResearch !== false && scoredQuestionIds.length > 0) {
      sessionId = clientSessionId ?? randomUUID();
      // Fire-and-forget: the research insert must not add latency to the match
      // response. Losing anonymized rows on a crash is acceptable.
      saveResearchResponses(sessionId, scoredQuestionIds, answers, weights).catch((err) => {
        console.error("voter_responses insert failed:", err.message);
      });
    }

    res.json({ sessionId, questionCount: scoredQuestionIds.length, results });
  } catch (err) {
    next(err);
  }
});

// The existence lookups return id order, so VALUES takes foreign-key KEY SHARE
// locks in the same order as admin merge/delete paths take FOR UPDATE locks.
async function saveResearchResponses(sessionId, questionIds, answers, weights) {
  const insert = (ids) => {
    const placeholders = ids
      .map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`)
      .join(", ");
    const values = [sessionId];
    for (const id of ids) {
      values.push(id, parseInt(answers[id], 10), weightFor(weights, id));
    }
    return db.query(
      `INSERT INTO voter_responses (session_id, question_id, value, weight) VALUES ${placeholders}
       ON CONFLICT DO NOTHING`,
      values
    );
  };

  try {
    await insert(questionIds);
  } catch (err) {
    if (err.code !== "23503") throw err;
    // A merge/delete can commit after the match lookup. The failed statement
    // inserted no rows; recheck only the originally scored questions and retry
    // once, preserving the session id and values. Continued churn is logged by
    // the caller, like other research failures, without delaying the response.
    const { rows } = await db.query(
      "SELECT id FROM questions WHERE id = ANY($1) ORDER BY id",
      [questionIds]
    );
    if (rows.length > 0) await insert(rows.map(row => row.id));
  }
}

module.exports = router;
