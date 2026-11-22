// The deploy job queues every later deploy behind it (concurrency:
// deploy-production, no cancel-in-progress), and GitHub only stops a job
// after 6 hours. So the job, and each step that talks to the server or the
// live site, must give up on its own when a connection stops answering
// (issue #178). verifyEdgeCache.test.js checks that the edge-cache script's
// slowest run fits its step's timeout.
const { workflowBlock, blockSetting } = require("../helpers/workflow");

const minutes = (block) => Number(blockSetting(block, "timeout-minutes"));

describe("deploy job", () => {
  test("has a timeout of its own", () => {
    const job = workflowBlock("deploy:");
    expect(minutes(job)).toBeGreaterThan(0);
    // The steps' timeouts fit inside it.
    const steps = ["- name: Verify deployment", "- name: Verify edge cache"].map(workflowBlock);
    expect(steps.reduce((sum, s) => sum + minutes(s), 0)).toBeLessThan(minutes(job));
  });

  // rsync and ssh both read ~/.ssh/config.
  test("ssh gives up on a server that stops answering", () => {
    const setup = workflowBlock("- name: Set up SSH");
    expect(setup).toMatch(/^\s*Host 80\.69\.172\.220$/m);
    expect(setup).toMatch(/^\s*ConnectTimeout \d+$/m);
    expect(setup).toMatch(/^\s*ServerAliveInterval \d+$/m);
    expect(setup).toMatch(/^\s*ServerAliveCountMax \d+$/m);
    // The server named in the config is the one the steps use.
    for (const name of ["- name: Rsync to server", "- name: Build & restart services"]) {
      expect(workflowBlock(name)).toContain("root@80.69.172.220");
    }
  });
});

describe("Verify edge cache", () => {
  test("has a timeout, and hitting it doesn't fail the deploy", () => {
    const step = workflowBlock("- name: Verify edge cache");
    expect(minutes(step)).toBeGreaterThan(0);
    // The check warns rather than fails the deploy; so must its timeout.
    expect(blockSetting(step, "continue-on-error")).toBe("true");
  });
});

describe("Verify deployment", () => {
  test("each health-check request has a time limit", () => {
    const curls = workflowBlock("- name: Verify deployment").match(/\bcurl\b[^\n]*/g);
    expect(curls).not.toBeNull();
    for (const curl of curls) expect(curl).toMatch(/(--max-time|-m)\s+\d+/);
  });

  test("the step has a timeout that every retry fits inside", () => {
    const text = workflowBlock("- name: Verify deployment");
    expect(minutes(text)).toBeGreaterThan(0);
    const maxTime = Number(text.match(/(?:--max-time|-m)\s+(\d+)/)?.[1]);
    const tries = Number(text.match(/\{1\.\.(\d+)\}/)?.[1]);
    const pause = Number(text.match(/\bsleep\s+(\d+)/)?.[1]);
    expect(tries).toBeGreaterThan(0);
    // Every try timing out must still leave room for the failure message,
    // so the timeout is a backstop, not the usual way the step ends.
    expect(tries * (maxTime + pause)).toBeLessThanOrEqual(minutes(text) * 60 * 0.75);
  });
});
