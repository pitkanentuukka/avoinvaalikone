const { Router } = require("express");
const db = require("../db/pool");
const { isValidUUID, validateUUIDArray, isValidRange } = require("../middleware/validation");

const router = Router();

/**
 * POST /api/voter/match
 *
 * Body:
 * {
 *   answers: { [questionId]: value (0-4) },
 *   weights: { [questionId]: weight (0-3) },   // optional
 *   questionSetIds: ["uuid", ...]               // optional filter
 * }
 *
 * Returns candidates ranked by match percentage.
 */
router.post("/match", async (req, res, next) => {
  try {
    const { answers, weights = {}, questionSetIds } = req.body;

    if (!answers || typeof answers !== "object" || Object.keys(answers).length === 0) {
      return res.status(400).json({ error: "Vastaukset vaaditaan" });
    }

    const voterQuestionIds = Object.keys(answers);

    // Reject if the caller sends more answers than there are questions in the DB.
    // This prevents unbounded voter_responses inserts without needing an arbitrary magic number.
    const { rows: [{ count: questionCount }] } = await db.query(
      "SELECT COUNT(*) FROM questions"
    );
    if (voterQuestionIds.length > parseInt(questionCount, 10)) {
      return res.status(400).json({ error: "Liian monta vastausta" });
    }

    // Validate all question IDs are valid UUIDs
    if (!voterQuestionIds.every(id => isValidUUID(id))) {
      return res.status(400).json({ error: "Virheelliset kysymyksen tunnisteet" });
    }

    // Validate all answer values are in range
    for (const value of Object.values(answers)) {
      if (!isValidRange(value, 0, 4)) {
        return res.status(400).json({ error: "Vastaus-arvot tulee olla 0-4" });
      }
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

    // Optionally filter to only questions within certain sets
    let questionFilter = "";
    const params = [voterQuestionIds];
    if (Array.isArray(questionSetIds) && questionSetIds.length > 0) {
      questionFilter = "AND q.question_set_id = ANY($2)";
      params.push(questionSetIds);
    }

    // Fetch all candidate answers for the relevant questions
    const { rows: candidateAnswers } = await db.query(
      `SELECT ca.candidate_id, ca.question_id, ca.value, ca.explanation
       FROM candidate_answers ca
       JOIN questions q ON q.id = ca.question_id
       WHERE ca.question_id = ANY($1)
       ${questionFilter}`,
      params
    );

    // Fetch candidate info
    const candidateIds = [...new Set(candidateAnswers.map((a) => a.candidate_id))];
    if (candidateIds.length === 0) {
      return res.json([]);
    }

    const { rows: candidates } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.bio,
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
        explanation: a.explanation,
      };
    });

    // Compute match scores
    const results = candidates.map((c) => {
      const cAnswers = answersByCandidate[c.id] || {};
      let totalWeight = 0;
      let weightedScore = 0;
      let answeredCount = 0;

      for (const qId of voterQuestionIds) {
        const voterValue = parseInt(answers[qId], 10);
        if (isNaN(voterValue) || !cAnswers[qId]) continue;

        const w = (parseInt(weights[qId], 10) || 0) + 1; // default weight 0 → factor 1; weight 3 → factor 4
        const diff = Math.abs(voterValue - cAnswers[qId].value);
        const similarity = 1 - diff / 4;

        weightedScore += similarity * w;
        totalWeight += w;
        answeredCount++;
      }

      const match = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;

      return {
        id: c.id,
        name: c.name,
        photoUrl: c.photo_url,
        bio: c.bio,
        partyId: c.party_id,
        partyName: c.party_name,
        match,
        answeredCount,
        answers: cAnswers,
      };
    });

    // Sort by match descending
    results.sort((a, b) => b.match - a.match);

    // Persist anonymous voter responses for aggregate analysis.
    // session_id is a server-generated random UUID — not linked to any identity.
    const { rows: [{ session_id: sessionId }] } = await db.query(
      "SELECT gen_random_uuid() AS session_id"
    );

    if (voterQuestionIds.length > 0) {
      const placeholders = voterQuestionIds
        .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
        .join(", ");
      const flatValues = [sessionId];
      for (const qId of voterQuestionIds) {
        flatValues.push(qId, parseInt(answers[qId], 10));
      }
      await db.query(
        `INSERT INTO voter_responses (session_id, question_id, value) VALUES ${placeholders}
         ON CONFLICT DO NOTHING`,
        flatValues
      );
    }

    res.json({ sessionId, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
