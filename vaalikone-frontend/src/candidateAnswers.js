export function answersFromProfile(me) {
  return Object.fromEntries(
    Object.entries(me.answers || {}).map(([k, v]) => [k, { value: v.value, text: v.explanation || "" }])
  );
}

// Reconcile the uncached profile fetched after a save skipped deleted questions.
export function reconcileAnswers(me, sent, current, skipped) {
  return answersFromProfile(me);
}
