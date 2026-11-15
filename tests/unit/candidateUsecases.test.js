const fs = require("fs");
const path = require("path");

const usecases = fs.readFileSync(path.join(__dirname, "../../usecases.md"), "utf8");
const section = (id) => usecases.match(new RegExp(`### ${id}:([\\s\\S]*?)(?=\\n### |\\n---)`))[1];

describe("candidate save use cases (issue #54)", () => {
  test.each(["UC-CAND-3", "UC-CAND-4"])("%s uses the candidate's own credential", (id) => {
    const text = section(id);
    expect(text).toContain("PUT /api/candidates/me/:candidateToken");
    expect(text).not.toContain(":partyToken");
    expect(text).not.toContain("**Actor:** Party admin");
  });

  test("profile use case describes the combined atomic save used by the UI", () => {
    const text = section("UC-CAND-3");
    expect(text).toMatch(/answers/);
    expect(text).toMatch(/same transaction/);
    expect(text).toMatch(/saved.*skipped/);
    expect(text).not.toContain("COALESCE");
  });

  test("answer use case distinguishes rejected answers from skipped questions", () => {
    const text = section("UC-CAND-4");
    expect(text).not.toContain("silently skipped");
    expect(text).toMatch(/400.*question/);
    expect(text).toMatch(/500/);
    expect(text).toMatch(/unknown.*removed.*skipped/);
  });
});
