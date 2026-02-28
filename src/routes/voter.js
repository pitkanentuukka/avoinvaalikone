const { Router } = require("express");
const db = require("../db/pool");

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

        const w = (parseInt(weights[qId], 10) || 1) + 1; // default weight 1, +1 so minimum is 1
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

    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
