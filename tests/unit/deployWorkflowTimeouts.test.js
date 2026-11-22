// The deploy job queues every later deploy behind it (concurrency:
// deploy-production, no cancel-in-progress), and GitHub only stops a job
// after 6 hours. So the job, and each step that talks to the server or the
// live site, must give up on its own when a connection stops answering
// (issue #178). verifyEdgeCache.test.js checks that the edge-cache script's
// slowest run fits the time the step gives it.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { workflow, step } = require("../helpers/workflow");

const SERVER = "80.69.172.220";
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

  // Runs the step's script with a throwaway HOME (ssh-keyscan stubbed, the
  // secret replaced) and asks ssh which options it would use for the server.
  // rsync's `-e ssh` reads the same config.
  test("ssh gives up on a server that stops answering", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ssh-"));
    try {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "ssh-keyscan"), "#!/bin/sh\necho keyscan-stub\n", { mode: 0o755 });
      const script = deployStep("Set up SSH").run.replace(/\$\{\{[^}]*\}\}/g, "not-a-key");
      const env = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` };
      const setup = spawnSync("bash", ["-e", "-c", script], { env, encoding: "utf8" });
      expect(setup.stderr).toBe("");
      expect(setup.status).toBe(0);

      const config = path.join(dir, ".ssh/config");
      const ssh = spawnSync("ssh", ["-G", "-F", config, `root@${SERVER}`], { env, encoding: "utf8" });
      expect(ssh.status).toBe(0);
      const options = Object.fromEntries(
        ssh.stdout.split("\n").filter(Boolean).map((l) => l.split(" ", 2))
      );
      expect(Number(options.connecttimeout)).toBeGreaterThan(0);
      expect(Number(options.serveraliveinterval)).toBeGreaterThan(0);
      expect(Number(options.serveralivecountmax)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the steps that use ssh connect to the server the config is for", () => {
    for (const name of ["Rsync to server", "Build & restart services"]) {
      expect(deployStep(name).run).toContain(`root@${SERVER}`);
    }
  });
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
