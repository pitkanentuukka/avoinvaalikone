// scripts/deploy.sh runs on the production host. A mailpit container (the
// dev-only mail catcher) left running there swallowed every email and
// published its web UI, magic links included (issue #190), so the script
// removes it. The script runs here with a stub `docker` first on PATH that
// records each call; no real Docker daemon is touched.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/deploy.sh");

// `docker ps` lists one mailpit container, or fails with STUB_PS=fail;
// `docker compose …` exits with STUB_COMPOSE_EXIT, as it does when the prod
// file's required variables (SMTP_HOST, SMTP_FROM) are missing from .env.
const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in
  ps) [ "\${STUB_PS:-}" = fail ] && { echo "permission denied" >&2; exit 1; }; echo mailpit123 ;;
  compose) exit "\${STUB_COMPOSE_EXIT:-0}" ;;
esac
`;

function runDeploy(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  fs.writeFileSync(path.join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  const result = spawnSync("sh", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_LOG: log,
      DEPLOY_LOCK: path.join(dir, "deploy.lock"),
      ...env,
    },
    encoding: "utf8",
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, calls };
}

const isMailpitRemoval = (call) => call === "rm -f mailpit123";

describe("scripts/deploy.sh mailpit removal", () => {
  // The project is named after the directory (no top-level `name:`), so
  // another project's mailpit on the same host is left alone.
  test("finds this project's mailpit by its Compose labels", () => {
    const project = path.basename(path.join(__dirname, "../.."));
    const { calls } = runDeploy({ COMPOSE_PROJECT_NAME: "" });
    expect(calls).toContain(
      `ps -aq --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=mailpit`
    );
  });

  // A project named otherwise (COMPOSE_PROJECT_NAME in .env) still has the
  // base file's fixed container_name; the stub finds the same container both
  // ways, so the removal also shows it's removed once.
  test("also finds it by its fixed container name", () => {
    const { calls } = runDeploy();
    expect(calls).toContain("ps -aq --filter name=^vaalikone-mailpit$");
    expect(calls.filter((c) => c.startsWith("rm "))).toEqual(["rm -f mailpit123", "rm -f mailpit123"]);
  });

  test("fails instead of skipping the removal when docker ps fails", () => {
    const { status, calls } = runDeploy({ STUB_PS: "fail" });
    expect(status).not.toBe(0);
    expect(calls.some((c) => c.startsWith("compose"))).toBe(false);
  });

  test("removes it before anything else, even when Compose refuses the config", () => {
    const { status, calls } = runDeploy({ STUB_COMPOSE_EXIT: "1" });
    expect(status).not.toBe(0);
    expect(calls.some(isMailpitRemoval)).toBe(true);
    expect(calls.findIndex(isMailpitRemoval)).toBeLessThan(calls.findIndex((c) => c.startsWith("compose")));
  });

  // COMPOSE_PROFILES=dev in .env would make `up` start it again.
  test("removes it again after `up`", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const up = calls.findIndex((c) => / up --build -d$/.test(c));
    expect(up).toBeGreaterThan(-1);
    expect(calls.slice(up + 1).some(isMailpitRemoval)).toBe(true);
  });
});

// CI's deploy job gives up on a server that stops answering (#178), so a
// deploy it lost contact with can still be running when the next one starts.
// The script waits for it instead of running a second `up --build`
// alongside. Another process holds the lock here, as a running deploy would.
describe("scripts/deploy.sh one deploy at a time", () => {
  let lockDir;
  let holder;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-lock-"));
  });
  afterEach(() => {
    if (holder && holder.exitCode === null) process.kill(-holder.pid, "SIGKILL");
    holder = undefined;
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  // Holds the lock for `seconds`, returning once it has it.
  function holdLock(lock, seconds) {
    const ready = path.join(lockDir, "ready");
    holder = spawn("flock", [lock, "sh", "-c", `touch "${ready}"; sleep ${seconds}`], {
      detached: true,
      stdio: "ignore",
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("lock holder didn't start");
      spawnSync("sleep", ["0.05"]);
    }
  }

  test("doesn't start while another deploy holds the lock", () => {
    const lock = path.join(lockDir, "deploy.lock");
    holdLock(lock, 10);
    const { status, stderr, calls } = runDeploy({ DEPLOY_LOCK: lock, DEPLOY_LOCK_WAIT: "1" });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Another deploy is still running/);
    // Not even the mailpit removal: nothing touches docker.
    expect(calls).toEqual([]);
  });

  test("goes ahead once the earlier deploy finishes", () => {
    const lock = path.join(lockDir, "deploy.lock");
    holdLock(lock, 1);
    const { status, calls } = runDeploy({ DEPLOY_LOCK: lock, DEPLOY_LOCK_WAIT: "10" });
    expect(status).toBe(0);
    expect(calls.some((c) => / up --build -d$/.test(c))).toBe(true);
  });
});
