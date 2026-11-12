const { scoreCandidate, compareResults } = require("../../src/match");

const Q1 = "550e8400-e29b-41d4-a716-446655440001";
const Q2 = "550e8400-e29b-41d4-a716-446655440002";
const Q3 = "550e8400-e29b-41d4-a716-446655440003";
const ALL = [Q1, Q2, Q3];

// ─── scoreCandidate ────────────────────────────────────────────────────────────

describe("scoreCandidate", () => {
  test("identical answers on every question → 100", () => {
    const answers = { [Q1]: 4, [Q2]: 2, [Q3]: 0 };
    const cAnswers = { [Q1]: { value: 4 }, [Q2]: { value: 2 }, [Q3]: { value: 0 } };
    expect(scoreCandidate(answers, {}, ALL, cAnswers)).toEqual({ match: 100, answeredCount: 3 });
  });

  // Issue #3: averaging only over overlapping questions let a candidate who
  // answered a single question (and agreed) score 100% and top the ranking.
  test("a question the candidate skipped counts as maximally distant", () => {
    const answers = { [Q1]: 2, [Q2]: 2, [Q3]: 2 };
    const cAnswers = { [Q1]: { value: 2 } };
    // 1 + 0 + 0 over 3 equally weighted questions → 33%
    expect(scoreCandidate(answers, {}, ALL, cAnswers)).toEqual({ match: 33, answeredCount: 1 });
  });

  test("a skipped question still carries the voter's weight", () => {
    const answers = { [Q1]: 2, [Q2]: 0 };
    const weights = { [Q1]: 0, [Q2]: 3 }; // factors 1 and 4
    // Candidate agrees on Q1 but skipped the question the voter cares most about:
    // (1·1 + 0·4) / (1 + 4) = 20%
    expect(scoreCandidate(answers, weights, [Q1, Q2], { [Q1]: { value: 2 } }))
      .toEqual({ match: 20, answeredCount: 1 });
  });

  test("full coverage at 92% beats one agreeing answer out of three", () => {
    const answers = { [Q1]: 2, [Q2]: 2, [Q3]: 2 };
    const few = scoreCandidate(answers, {}, ALL, { [Q1]: { value: 2 } });
    const all = scoreCandidate(answers, {}, ALL, {
      [Q1]: { value: 2 }, [Q2]: { value: 2 }, [Q3]: { value: 3 },
    });
    expect(all.match).toBe(92);
    expect(all.match).toBeGreaterThan(few.match);
  });

  test("a question without a usable voter value is left out entirely", () => {
    const answers = { [Q1]: 2, [Q2]: "x" };
    expect(scoreCandidate(answers, {}, [Q1, Q2], { [Q1]: { value: 2 } }))
      .toEqual({ match: 100, answeredCount: 1 });
  });
});

// ─── compareResults ────────────────────────────────────────────────────────────

describe("compareResults", () => {
  const sorted = (results) => [...results].sort(compareResults).map((r) => r.name);

  test("higher match first", () => {
    expect(sorted([
      { name: "A", match: 50, answeredCount: 3 },
      { name: "B", match: 80, answeredCount: 1 },
    ])).toEqual(["B", "A"]);
  });

  test("equal match → the candidate who answered more questions first", () => {
    expect(sorted([
      { name: "A", match: 50, answeredCount: 1 },
      { name: "B", match: 50, answeredCount: 3 },
    ])).toEqual(["B", "A"]);
  });

  test("equal match and answeredCount → alphabetical by name (Finnish collation)", () => {
    expect(sorted([
      { name: "Östman", match: 50, answeredCount: 2 },
      { name: "Aalto", match: 50, answeredCount: 2 },
      { name: "Wahlroos", match: 50, answeredCount: 2 },
    ])).toEqual(["Aalto", "Wahlroos", "Östman"]);
  });
});
