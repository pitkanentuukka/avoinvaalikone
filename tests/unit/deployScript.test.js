// scripts/deploy.sh runs on the production host. A mailpit container (the
// dev-only mail catcher) left running there swallowed every email and
// published its web UI, magic links included (issue #190), so the script
// removes it. The script runs here with a stub `docker` first on PATH that
// records each call; no real Docker daemon is touched.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "../../scripts/deploy.sh");

// `docker ps` lists one mailpit container, or fails with STUB_PS=fail;
// `docker compose …` exits with STUB_COMPOSE_EXIT, as it does when the prod
// file's required variables (SMTP_HOST, SMTP_FROM) are missing from .env.
// Any call containing STUB_FAIL (e.g. " pull ", "build --pull") fails, as a
// pull does when Docker Hub is down or rate-limits the server. With
// STUB_PULL_HANG set, `compose … pull` hangs, as a stalled transfer does.
const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL:-}" ]; then
  case "$*" in *"$STUB_FAIL"*) echo "stub: $* failed" >&2; exit 1 ;; esac
fi
case "$* " in *" pull "*) [ -n "\${STUB_PULL_HANG:-}" ] && exec sleep 30 ;; esac
case "$1" in
  ps) [ "\${STUB_PS:-}" = fail ] && { echo "permission denied" >&2; exit 1; }; echo mailpit123 ;;
  compose) exit "\${STUB_COMPOSE_EXIT:-0}" ;;
esac
`;

// With `dotenv`, the script runs from a copy of the tree with that .env (it
// reads .env from the tree it is in); otherwise from this checkout.
function runDeploy(env = {}, dotenv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  fs.writeFileSync(path.join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  let script = SCRIPT;
  if (dotenv !== undefined) {
    const tree = path.join(dir, "tree");
    fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
    script = path.join(tree, "scripts", "deploy.sh");
    fs.copyFileSync(SCRIPT, script);
    fs.copyFileSync(path.join(__dirname, "../../Caddyfile"), path.join(tree, "Caddyfile"));
    fs.writeFileSync(path.join(tree, ".env"), dotenv);
  }
  const result = spawnSync("sh", [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, ...env },
    encoding: "utf8",
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, calls, output: result.stdout + result.stderr };
}

const isMailpitRemoval = (call) => call === "rm -f mailpit123";
const COMPOSE = "compose -f docker-compose.yml -f docker-compose.prod.yml";
const isUp = (call) => call.startsWith(`${COMPOSE} up `) && / -d( |$)/.test(call);

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
    const up = calls.findIndex(isUp);
    expect(up).toBeGreaterThan(-1);
    expect(calls.slice(up + 1).some(isMailpitRemoval)).toBe(true);
  });
});

// Compose's default pull policy is `missing`: without these the server kept
// the digest it first pulled of every tag, base images and service images
// alike, and never got their security patches (#216).
describe("scripts/deploy.sh image refresh", () => {
  test("pulls the service images before `up`, skipping the ones it builds", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const pull = calls.indexOf(`${COMPOSE} pull --ignore-buildable`);
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(calls.findIndex(isUp));
  });

  test("builds on freshly pulled base images before `up`", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const build = calls.indexOf(`${COMPOSE} build --pull`);
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(calls.findIndex(isUp));
  });

  // The old images keep serving; Docker Hub being down mustn't block a fix.
  test("a failed service pull warns and deploys with the images it has", () => {
    const { status, calls, output } = runDeploy({ STUB_FAIL: " pull --ignore-buildable" });
    expect(status).toBe(0);
    expect(calls.some(isUp)).toBe(true);
    expect(output).toMatch(/::warning::.*pull/i);
  });

  test("a failed base pull warns and builds on the base images it has", () => {
    const { status, calls, output } = runDeploy({ STUB_FAIL: "build --pull" });
    expect(status).toBe(0);
    const fallback = calls.indexOf(`${COMPOSE} build`);
    expect(fallback).toBeGreaterThan(calls.indexOf(`${COMPOSE} build --pull`));
    expect(fallback).toBeLessThan(calls.findIndex(isUp));
    expect(output).toMatch(/::warning::.*base image/i);
    // It may as well be the newer bases that break the build.
    expect(output).toMatch(/::warning::.*output above/i);
  });

  test("a build that fails on its own still fails the deploy, before `up`", () => {
    const { status, calls } = runDeploy({ STUB_FAIL: " build" });
    expect(status).not.toBe(0);
    expect(calls.some(isUp)).toBe(false);
  });

    test("`up` neither rebuilds nor pulls again", () => {
    const { calls } = runDeploy();
    const up = calls.find(isUp);
    expect(up).not.toMatch(/--build|--pull/);
  });

  // A config Compose refuses (a .env without SMTP_HOST) is not Docker Hub's
  // fault: it must fail with Compose's message, not warnings blaming the pull.
  test("a config Compose refuses fails before any pull warning", () => {
    const { status, calls, output } = runDeploy({ STUB_COMPOSE_EXIT: "1" });
    expect(status).not.toBe(0);
    expect(calls.filter((c) => c.startsWith("compose"))).toEqual([`${COMPOSE} config -q`]);
    expect(output).not.toMatch(/::warning::/);
  });

  test("a pull that hangs is given up on, and the deploy carries on", () => {
    const { status, calls, output } = runDeploy({ STUB_PULL_HANG: "1", DEPLOY_PULL_TIMEOUT: "1" });
    expect(status).toBe(0);
    expect(calls.some(isUp)).toBe(true);
    expect(output).toMatch(/::warning::.*pull/i);
  });

  // The prune deletes the replaced images, so the log is where the digests
  // that last worked can still be found (docs/runbook.md, Rollback).
  test("logs the image digests it starts from, before pulling", () => {
    const { calls } = runDeploy();
    const list = calls.findIndex((c) => c.startsWith("image ls --digests"));
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(calls.indexOf(`${COMPOSE} pull --ignore-buildable`));
  });

  // A freeze (election night): a hotfix shouldn't also restart the database
  // because upstream rebuilt postgres:16-alpine that day.
  test.each([
    ["the environment", { DEPLOY_PULL: "0" }, ""],
    [".env", {}, "SMTP_HOST=x\nDEPLOY_PULL=0\n"],
  ])("DEPLOY_PULL=0 in %s skips the refresh", (_where, env, dotenv) => {
    const { status, calls } = runDeploy(env, dotenv);
    expect(status).toBe(0);
    expect(calls.some((c) => / pull( |$)/.test(c) || /--pull/.test(c))).toBe(false);
    expect(calls.indexOf(`${COMPOSE} build`)).toBeLessThan(calls.findIndex(isUp));
    expect(calls.indexOf(`${COMPOSE} build`)).toBeGreaterThan(-1);
  });

  // Each refresh, and each rebuild, leaves the previous image untagged.
  test("prunes dangling images after `up`", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const prune = calls.indexOf("image prune -f");
    expect(prune).toBeGreaterThan(calls.findIndex(isUp));
  });

  test("a failed prune doesn't fail a deploy that has happened", () => {
    const { status, output } = runDeploy({ STUB_FAIL: "image prune" });
    expect(status).toBe(0);
    expect(output).toMatch(/::warning::.*prune/i);
  });
});

// Pulling means `up` can recreate caddy on a newer Caddy than the one that
// last accepted the Caddyfile. Validating only afterwards, and only when the
// file changed, would let a Caddyfile the new version rejects crash-loop it
// and take the site down (#216).
describe("scripts/deploy.sh Caddyfile validation", () => {
  const isValidate = (c) => c.startsWith(`${COMPOSE} run --rm --no-deps -T caddy caddy validate `);

  test("validates the Caddyfile on the pulled image before `up`, every deploy", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const pull = calls.indexOf(`${COMPOSE} pull --ignore-buildable`);
    const validate = calls.findIndex(isValidate);
    expect(pull).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(pull);
    expect(validate).toBeLessThan(calls.findIndex(isUp));
  });

  test("a Caddyfile the new Caddy rejects stops the deploy before `up`", () => {
    const { status, calls } = runDeploy({ STUB_FAIL: "caddy validate" });
    expect(status).not.toBe(0);
    expect(calls.some(isUp)).toBe(false);
  });
});

// Patch releases arrive with every deploy, minor ones only deliberately: the
// Caddyfile's token redaction (#36) depends on how Caddy lays out its logs,
// which `caddy validate` can't check. A digest may follow, as docs/runbook.md
// says to pin one when a pulled image breaks the site.
test("docker-compose.prod.yml pins Caddy's minor version", () => {
  const prod = fs.readFileSync(path.join(__dirname, "../../docker-compose.prod.yml"), "utf8");
  expect(prod).toMatch(/^\s*image: caddy:2\.\d+-alpine(@sha256:[0-9a-f]{64})?\s*$/m);
});

// The pulled nginx gets no `caddy validate` of its own: a config it rejects
// must fail the build (and so the deploy, before `up`), not crash-loop the
// frontend.
test("the frontend image checks its nginx config at build time", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "../../vaalikone-frontend/Dockerfile"), "utf8");
  const copy = dockerfile.indexOf("COPY nginx.conf");
  const check = dockerfile.search(/^RUN nginx -t\b/m);
  expect(copy).toBeGreaterThan(-1);
  expect(check).toBeGreaterThan(copy);
});

// Compose's default stop timeout (10 s) can SIGKILL Postgres mid-checkpoint,
// and a pulled postgres image now recreates db on a routine deploy.
test("db gets time to shut down cleanly", () => {
  const base = fs.readFileSync(path.join(__dirname, "../../docker-compose.yml"), "utf8");
  const db = base.slice(base.indexOf("\n  db:\n"), base.indexOf("\n  redis:\n"));
  const grace = db.match(/^\s*stop_grace_period: (\d+)s$/m);
  expect(grace).not.toBeNull();
  expect(Number(grace[1])).toBeGreaterThanOrEqual(30);
});
