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
// Any call containing STUB_FAIL (e.g. " pull ", "pull node:") fails, as a
// pull does when Docker Hub is down or rate-limits the server. With
// STUB_PULL_HANG set, every pull hangs, as a stalled transfer does; with
// STUB_BUILD_HANG, `compose … build` does, and with STUB_BUILD_SLEEP it takes
// that many seconds.
const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL:-}" ]; then
  case "$*" in *"$STUB_FAIL"*) echo "stub: $* failed" >&2; exit 1 ;; esac
fi
case " $* " in *" pull "*) [ -n "\${STUB_PULL_HANG:-}" ] && exec sleep 30 ;; esac
case " $* " in *" build "*)
  [ -n "\${STUB_BUILD_HANG:-}" ] && exec sleep 30
  [ -n "\${STUB_BUILD_SLEEP:-}" ] && sleep "$STUB_BUILD_SLEEP" ;;
esac
case "$1" in
  ps) [ "\${STUB_PS:-}" = fail ] && { echo "permission denied" >&2; exit 1; }; echo mailpit123 ;;
  compose) exit "\${STUB_COMPOSE_EXIT:-0}" ;;
esac
`;

// The script runs from a copy of the tree (it reads .env and the
// Dockerfiles from the tree it is in), named TREE, with `dotenv` as its .env
// and `dockerfiles` replacing the real Dockerfiles. Nothing from the
// developer's checkout or shell (.env, DEPLOY_*) reaches it. A `wrapper`
// shell command runs it instead, as "$1".
const ROOT = path.join(__dirname, "../..");
const TREE = "deploy-tree";
const DOCKERFILES = ["Dockerfile", "vaalikone-frontend/Dockerfile", "scripts/backup/Dockerfile"];
function runDeploy(env = {}, dotenv = "", dockerfiles = {}, wrapper) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  fs.writeFileSync(path.join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  const tree = path.join(dir, TREE);
  const files = { "scripts/deploy.sh": null, Caddyfile: null, ...Object.fromEntries(DOCKERFILES.map((f) => [f, null])), ...dockerfiles };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
    fs.writeFileSync(path.join(tree, file), content ?? fs.readFileSync(path.join(ROOT, file)));
  }
  fs.writeFileSync(path.join(tree, ".env"), dotenv);
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DEPLOY_|STUB_|COMPOSE_)/.test(k)));
  const script = path.join(tree, "scripts/deploy.sh");
  const result = spawnSync("sh", wrapper ? ["-c", wrapper, "sh", script] : [script], {
    env: { ...baseEnv, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, ...env },
    encoding: "utf8",
    // Jest's own timeout can't interrupt spawnSync: a deploy that hangs
    // fails its test instead of the whole run.
    timeout: 20000,
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
    const { calls } = runDeploy({ COMPOSE_PROJECT_NAME: "" });
    expect(calls).toContain(
      `ps -aq --filter label=com.docker.compose.project=${TREE} --filter label=com.docker.compose.service=mailpit`
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
  const isBuild = (c) => c === `${COMPOSE} build`;
  const isPull = (c) => / pull( |$)/.test(c) || /--pull/.test(c);
  // What the real Dockerfiles build on, read independently of deploy.sh.
  const BASES = [
    ...new Set(DOCKERFILES.flatMap((f) => [...fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]))),
  ];

  test("pulls the service images before `up`, skipping the ones it builds", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    const pull = calls.indexOf(`${COMPOSE} pull --ignore-buildable`);
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(calls.findIndex(isUp));
  });

  // Tagged by `docker pull`, they are a copy the build can fall back to when
  // Docker Hub can't be reached (BuildKit doesn't tag the images it fetches
  // itself). Only the calls are checked: what BuildKit then builds on is the
  // daemon's business, beyond a stub.
  test("pulls each Dockerfile's base image, then builds on them", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    expect(BASES.length).toBeGreaterThanOrEqual(3);
    const build = calls.findIndex(isBuild);
    for (const image of BASES) {
      const pull = calls.indexOf(`pull ${image}`);
      expect(pull).toBeGreaterThan(-1);
      expect(pull).toBeLessThan(build);
    }
    expect(build).toBeLessThan(calls.findIndex(isUp));
    expect(calls.some((c) => c.includes("build --pull"))).toBe(false);
  });

  // deploy.sh lists the Dockerfiles itself: it must list every image Compose builds.
  test("knows every Dockerfile Compose builds from", () => {
    const compose = ["docker-compose.yml", "docker-compose.prod.yml"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
    const built = [
      ...[...compose.matchAll(/^\s*context: (\S+)\n(?:\s*dockerfile: (\S+))?/gm)].map((m) => path.join(m[1], m[2] || "Dockerfile")),
      ...[...compose.matchAll(/^\s*build: ([^\s{]\S*)$/gm)].map((m) => path.join(m[1], "Dockerfile")),
    ].map((f) => path.normalize(f));
    expect(built.sort()).toEqual([...DOCKERFILES].sort());
    const listed = fs.readFileSync(SCRIPT, "utf8").match(/^dockerfiles="([^"]*)"$/m);
    expect(listed[1].split(" ").sort()).toEqual([...DOCKERFILES].sort());
  });

  test("skips FROM options, earlier stages and what isn't an image", () => {
    const { status, calls } = runDeploy({}, "", {
      Dockerfile:
        "ARG BASE=x\nFROM --platform=linux/amd64 node:24-alpine AS Build\nRUN true\nfrom build as again\nFROM again\nFROM scratch\nFROM ${BASE}\nFROM \\\n  y\n",
    });
    expect(status).toBe(0);
    expect(calls).toContain("pull node:24-alpine");
    expect(calls.filter((c) => /^pull /.test(c) && !/^pull (node|nginxinc|postgres)/.test(c))).toEqual([]);
  });

  // The old images keep serving; Docker Hub being down mustn't block a fix.
  test("a failed service pull warns and deploys with the images it has", () => {
    const { status, calls, output } = runDeploy({ STUB_FAIL: " pull --ignore-buildable" });
    expect(status).toBe(0);
    expect(calls.some(isBuild)).toBe(true);
    expect(calls.some(isUp)).toBe(true);
    expect(output).toMatch(/::warning::Pulling the service images failed/);
  });

  test("a failed base pull warns and builds on the copy it has", () => {
    const { status, calls, output } = runDeploy({ STUB_FAIL: "pull node:" });
    expect(status).toBe(0);
    expect(calls.findIndex(isBuild)).toBeLessThan(calls.findIndex(isUp));
    expect(output).toMatch(/::warning::Pulling the base image node:24-alpine failed/);
  });

  test("a failed build fails the deploy, before `up`", () => {
    const { status, calls } = runDeploy({ STUB_FAIL: " build" });
    expect(status).not.toBe(0);
    expect(calls.some(isUp)).toBe(false);
  });

  test("`up` neither rebuilds nor pulls again", () => {
    const { status, calls } = runDeploy();
    expect(status).toBe(0);
    expect(calls.find(isUp)).not.toMatch(/--build|--pull/);
  });

  // A config Compose refuses (a .env without SMTP_HOST) is not Docker Hub's
  // fault: it must fail with Compose's message, not warnings blaming the pull.
  test("a config Compose refuses fails before any pull warning", () => {
    const { status, calls, output } = runDeploy({ STUB_COMPOSE_EXIT: "1" });
    expect(status).not.toBe(0);
    expect(calls.filter((c) => c.startsWith("compose"))).toEqual([`${COMPOSE} config -q`]);
    expect(output).not.toMatch(/::warning::/);
  });

  test("pulls that hang are given up on, and the deploy carries on", () => {
    const { status, calls, output } = runDeploy({ STUB_PULL_HANG: "1", DEPLOY_PULL_TIMEOUT: "1" });
    expect(status).toBe(0);
    expect(calls.some(isUp)).toBe(true);
    expect(output).toMatch(/::warning::Pulling the service images failed or timed out/);
    expect(output).toMatch(/::warning::Pulling the base image .* failed or timed out/);
  });

  // It holds the deploy lock: later deploys' rsyncs give up after 10 minutes.
  test("a build that hangs is given up on, and fails the deploy before `up`", () => {
    const { status, calls, output } = runDeploy({ STUB_BUILD_HANG: "1", DEPLOY_BUILD_TIMEOUT: "1" });
    expect(status).not.toBe(0);
    expect(calls.some(isUp)).toBe(false);
    expect(output).toMatch(/::error::Building the images failed or timed out/);
  });

  // deploy-detached.sh runs the deploy under nohup (#205). GNU timeout would
  // catch the hangup and stop the build with it; the time limit here mustn't.
  test("a hangup during the build doesn't stop it", () => {
    const wrapper = `
      trap '' HUP
      nohup sh "$1" > "$STUB_LOG.out" 2>&1 &
      deploy=$!
      n=0
      until grep -q " build$" "$STUB_LOG" 2>/dev/null; do
        n=$((n + 1)); [ "$n" -lt 200 ] || { cat "$STUB_LOG.out"; exit 99; }
        sleep 0.05
      done
      pkill -HUP -s $$
      wait "$deploy"
      status=$?
      cat "$STUB_LOG.out"
      exit "$status"`;
    const { status, calls } = runDeploy({ STUB_BUILD_SLEEP: "1" }, "", {}, `exec setsid -w sh -c '${wrapper.replace(/'/g, "'\\''")}' sh "$1"`);
    expect(status).toBe(0);
    expect(calls.some(isUp)).toBe(true);
  });

  // The watchdog can't read them; GNU timeout's `20m` must not mean "no limit".
  test.each([["DEPLOY_BUILD_TIMEOUT", "20m"], ["DEPLOY_PULL_TIMEOUT", "0"], ["DEPLOY_PULL_TIMEOUT", "1.5"]])(
    "%s=%s is refused before anything is pulled",
    (name, value) => {
      const { status, calls, output } = runDeploy({ [name]: value });
      expect(status).not.toBe(0);
      expect(calls.some((c) => c.startsWith("compose") || c.startsWith("pull"))).toBe(false);
      expect(output).toMatch(/whole seconds/);
    }
  );

  // The prune deletes the replaced images, so the log is where the digests
  // that last worked can still be found (docs/runbook.md, Rollback).
  test("logs the image digests it starts from, before pulling", () => {
    const { calls } = runDeploy();
    // --all: Docker 29 leaves out untagged images otherwise, which are what a
    // container from a half-failed deploy runs.
    const list = calls.findIndex((c) => c.startsWith("image ls --all --digests"));
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(calls.findIndex(isPull));
  });

  // A deploy that failed after pulling moved the tag, but not the container.
  test("logs the images the containers run, before pulling", () => {
    const { calls } = runDeploy();
    const running = calls.findIndex((c) => c.startsWith("inspect ") && c.endsWith(" mailpit123"));
    expect(running).toBeGreaterThan(-1);
    expect(running).toBeLessThan(calls.findIndex(isPull));
  });

  // A freeze (election night): a hotfix shouldn't also restart the database
  // because upstream rebuilt postgres:16-alpine that day.
  test.each([
    ["the environment", { DEPLOY_PULL: "0" }, ""],
    [".env", {}, "SMTP_HOST=x\nDEPLOY_PULL=0\n"],
    [".env, with a comment", {}, "DEPLOY_PULL=0  # vaali-ilta\n"],
    [".env, with a trailing space", {}, "DEPLOY_PULL=0 \n"],
    [".env, with CRLF", {}, "SMTP_HOST=x\r\nDEPLOY_PULL=0\r\n"],
    [".env, quoted and exported", {}, 'export DEPLOY_PULL = "0"\n'],
    [".env, as off", {}, "DEPLOY_PULL=off\n"],
    [".env, in capitals", {}, "DEPLOY_PULL=FALSE\n"],
    [".env, quoted with a space", {}, 'DEPLOY_PULL=" 0"\n'],
  ])("DEPLOY_PULL=0 in %s skips the refresh, with a warning", (_where, env, dotenv) => {
    const { status, calls, output } = runDeploy(env, dotenv);
    expect(status).toBe(0);
    expect(calls.some(isPull)).toBe(false);
    expect(calls.findIndex(isBuild)).toBeGreaterThan(-1);
    expect(calls.findIndex(isBuild)).toBeLessThan(calls.findIndex(isUp));
    // So that a freeze left in place shows on every CI run.
    expect(output).toMatch(/::warning::DEPLOY_PULL=/);
  });

  test("the environment wins over .env", () => {
    const { calls } = runDeploy({ DEPLOY_PULL: "1" }, "DEPLOY_PULL=0\n");
    expect(calls.some(isPull)).toBe(true);
  });

  test("a DEPLOY_PULL that is neither 0 nor 1 pulls, with a warning", () => {
    const { status, calls, output } = runDeploy({}, "DEPLOY_PULL=O\n");
    expect(status).toBe(0);
    expect(calls.some(isPull)).toBe(true);
    expect(output).toMatch(/::warning::DEPLOY_PULL=O is neither/);
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
