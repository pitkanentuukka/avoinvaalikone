// The deploy job queues every later deploy behind it (concurrency:
// deploy-production, no cancel-in-progress), and GitHub only stops a job
// after 6 hours. So its post-deploy checks of the live site, which can meet a
// connection that never answers, must give up on their own (issue #178).
// verifyEdgeCache.test.js covers the "Verify edge cache" step; this covers
// the health check before it.
const fs = require("fs");
const path = require("path");

const WORKFLOW = path.join(__dirname, "../../.github/workflows/ci-cd.yml");

// A step's lines, from its `- name:` up to the next step.
function step(name) {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const indent = lines[start].indexOf("-");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() && l.search(/\S/) <= indent);
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("Verify deployment", () => {
  test("each health-check request has a time limit", () => {
    const curls = step("Verify deployment").match(/\bcurl\b[^\n]*/g);
    expect(curls).not.toBeNull();
    for (const curl of curls) expect(curl).toMatch(/(--max-time|-m)\s+\d+/);
  });

  test("the step has a timeout that every retry fits inside", () => {
    const text = step("Verify deployment");
    const minutes = Number(text.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    const maxTime = Number(text.match(/(?:--max-time|-m)\s+(\d+)/)?.[1]);
    const tries = Number(text.match(/\{1\.\.(\d+)\}/)?.[1]);
    const pause = Number(text.match(/\bsleep\s+(\d+)/)?.[1]);
    expect(tries).toBeGreaterThan(0);
    // Every try timing out must still leave room for the failure message,
    // so the timeout is a backstop, not the usual way the step ends.
    expect(tries * (maxTime + pause)).toBeLessThanOrEqual(minutes * 60 * 0.75);
  });
});
