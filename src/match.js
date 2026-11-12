// Weight used for a question the voter didn't weight. The weighting UI shows
// "somewhat important" (1) as selected until the voter picks something else and
// sends only the weights the voter clicked, so a missing weight means 1.
const DEFAULT_WEIGHT = 1;

function weightFor(weights, qId) {
  return weights[qId] === undefined ? DEFAULT_WEIGHT : parseInt(weights[qId], 10);
}

/**
 * Scores one candidate against the voter. A question the voter answered but the
 * candidate skipped counts as maximally distant (similarity 0) with the voter's
 * weight, so a candidate can't reach a high match by answering only the few
 * questions they agree with the voter on.
 *
 * @param answers          { [questionId]: voter value 0-4 }
 * @param weights          { [questionId]: weight 0-3 }, missing → DEFAULT_WEIGHT
 * @param questionIds      the voter's questions to score on
 * @param candidateAnswers { [questionId]: { value } }
 * @returns { match: 0-100, answeredCount: questions both answered }
 */
function scoreCandidate(answers, weights, questionIds, candidateAnswers) {
  let totalWeight = 0;
  let weightedScore = 0;
  let answeredCount = 0;

  for (const qId of questionIds) {
    const voterValue = parseInt(answers[qId], 10);
    if (isNaN(voterValue)) continue;

    const w = weightFor(weights, qId) + 1; // weight 0 → factor 1; weight 3 → factor 4
    totalWeight += w;
    if (!candidateAnswers[qId]) continue;

    const diff = Math.abs(voterValue - candidateAnswers[qId].value);
    const similarity = 1 - diff / 4;

    weightedScore += similarity * w;
    answeredCount++;
  }

  const match = totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0;
  return { match, answeredCount };
}

// Sort order for match results: best match first, then the candidate who
// answered more of the voter's questions, then by name (and id, for namesakes)
// so equal results always come out in the same order. Ranking uses the rounded
// match the voter sees, so two candidates shown at the same percentage are
// ordered by coverage rather than by a difference the voter can't see.
function compareResults(a, b) {
  return b.match - a.match
    || b.answeredCount - a.answeredCount
    || a.name.localeCompare(b.name, "fi")
    || a.id.localeCompare(b.id);
}

module.exports = { DEFAULT_WEIGHT, weightFor, scoreCandidate, compareResults };
