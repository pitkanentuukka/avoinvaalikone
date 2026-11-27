// The deploy job queues every later deploy behind it (concurrency:
// deploy-production, no cancel-in-progress), and GitHub only stops a job
// after 6 hours. So the job, and each step that talks to the server or the
// live site, must give up on its own when a connection stops answering
// (issue #178). verifyEdgeCache.test.js checks that the edge-cache script's
// slowest run fits the time the step gives it.
const fs = require("fs");
const path = require("path");
const { workflow, step } = require("../helpers/workflow");
const { SERVER, runSetupSsh, sshOptions } = require("../helpers/deploySsh");

// Any well-formed ed25519 key will do: these tests never connect.
const PINNED_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const deployStep = (name) => step("deploy", name);

describe("deploy job", () => {
  test("has a timeout of its own, with room for the build", () => {
    const job = workflow().jobs.deploy;
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    // The build step has no limit of its own (a cold build can be slow), so
    // what the job's other limited steps may use leaves it at least this.
    const limited = job.steps.filter((s) => s["timeout-minutes"]);
    const used = limited.reduce((sum, s) => sum + s["timeout-minutes"], 0);
    expect(job["timeout-minutes"] - used).toBeGreaterThanOrEqual(20);
  });

  // rsync's `-e ssh` reads the same config.
  test("ssh gives up on a server that stops answering", () => {
    const h = runSetupSsh({ vars: { SSH_KNOWN_HOSTS: `${SERVER} ssh-ed25519 ${PINNED_KEY}` } });
    try {
      expect(h.result.stderr).toBe("");
      expect(h.result.status).toBe(0);
      const options = sshOptions(h);
      expect(Number(options.connecttimeout)).toBeGreaterThan(0);
      expect(Number(options.serveraliveinterval)).toBeGreaterThan(0);
      expect(Number(options.serveralivecountmax)).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  test("the steps that use ssh connect to the server the config is for", () => {
    for (const name of ["Rsync to server", "Build & restart services"]) {
      expect(deployStep(name).run).toContain(`root@${SERVER}`);
    }
  });
});

// Searched for with the line ssh printed, which names the host.
test("docs/runbook.md quotes ssh's timeout message as ssh prints it", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../docs/runbook.md"), "utf8");
  expect(runbook).toContain(`Timeout, server ${SERVER} not responding.`);
});

describe("Verify edge cache", () => {
  test("has a timeout, and hitting it doesn't fail the deploy", () => {
    const s = deployStep("Verify edge cache");
    expect(s["timeout-minutes"]).toBeGreaterThan(0);
    // The check warns rather than fails the deploy; so must its timeout.
    expect(s["continue-on-error"]).toBe(true);
  });
});

describe("Verify deployment", () => {
  test("each health-check request has a time limit", () => {
    const curls = deployStep("Verify deployment").run.match(/\bcurl\b[^\n]*/g);
    expect(curls).not.toBeNull();
    for (const curl of curls) expect(curl).toMatch(/(--max-time|-m)\s+\d+/);
  });

  test("the step has a timeout that every retry fits inside", () => {
    const s = deployStep("Verify deployment");
    expect(s["timeout-minutes"]).toBeGreaterThan(0);
    const maxTime = Number(s.run.match(/(?:--max-time|-m)\s+(\d+)/)?.[1]);
    const tries = Number(s.run.match(/\{1\.\.(\d+)\}/)?.[1]);
    const pause = Number(s.run.match(/\bsleep\s+(\d+)/)?.[1]);
    expect(tries).toBeGreaterThan(0);
    // Every try timing out must still leave room for the failure message,
    // so the timeout is a backstop, not the usual way the step ends.
    expect(tries * (maxTime + pause)).toBeLessThanOrEqual(s["timeout-minutes"] * 60 * 0.75);
  });
});
