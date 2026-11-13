// Question-list helpers shared by the candidate and party views. Kept free of
// Vite-only syntax so the unit tests can import it under Node.

// Questions shown on the page: those in approved sets, each once even when
// several sets share it.
export function distinctQuestions(questionSets) {
  const approved = questionSets.filter((s) => s.status === "approved");
  return [...new Map(approved.flatMap((s) => s.questions || []).map((q) => [q.id, q])).values()];
}

// How many of the questions the candidate has rated.
export function answeredCount(answers, questions) {
  return Object.values(answers).filter((a) => a.value !== undefined).length;
}
