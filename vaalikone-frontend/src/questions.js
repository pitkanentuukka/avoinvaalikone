// Question-list helpers shared by the candidate and party views. Kept free of
// Vite-only syntax so the unit tests can import it under Node.

// Questions shown on the page: those in approved sets, each once even when
// several sets share it.
export function distinctQuestions(questionSets) {
  const approved = questionSets.filter((s) => s.status === "approved");
  return [...new Map(approved.flatMap((s) => s.questions || []).map((q) => [q.id, q])).values()];
}

// How many of the questions the candidate has rated. Answers loaded from the
// server can include questions not on the page (sets no longer approved), so
// count by question rather than by answer (#19).
export function answeredCount(answers, questions) {
  return questions.filter((q) => answers[q.id]?.value !== undefined).length;
}
