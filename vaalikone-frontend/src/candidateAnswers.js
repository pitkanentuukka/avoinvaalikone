export function answersFromProfile(me) {
  return Object.fromEntries(
    Object.entries(me.answers || {}).map(([k, v]) => [k, { value: v.value, text: v.explanation || "" }])
  );
}

// Reconcile the uncached profile fetched after a save skipped deleted questions.
export function reconcileAnswers(me, sent, current, skipped) {
  const refreshed = answersFromProfile(me);
  for (const [qId, answer] of Object.entries(current)) {
    // State updates replace answer objects, so sent remains the save snapshot.
    // Compare fields so equivalent objects still accept server merge results.
    if (answer.value !== sent[qId]?.value || answer.text !== sent[qId]?.text) {
      refreshed[qId] = answer;
    }
  }
  for (const qId of skipped) delete refreshed[qId];
  return refreshed;
}
