// The deploy job drives the server over ssh, and ssh gives up on a server
// that stops answering (#178). Losing the connection must not cut a deploy
// short, and a deploy CI has lost contact with must still keep the next one
// out of /opt/vaalikone until it is done (#205).
//
// These run the workflow's own "Rsync to server" and "Build & restart
// services" commands. A stub `ssh` runs the remote command here, in a
// throwaway copy of the tree standing in for /opt/vaalikone; a stub `docker`
// records each call, prints output as Compose does, and sleeps in `up`.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step } = require("../helpers/workflow");

const REPO = path.join(__dirname, "../..");
const SERVER_TREE = "/opt/vaalikone";

const DOCKER_STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in
  ps) echo mailpit123 ;;
  compose)
    case " $* " in *" up "*) sleep "\${STUB_UP_SLEEP:-0}" ;; esac
    echo "docker $*"
    exit "\${STUB_COMPOSE_EXIT:-0}" ;;
esac
`;

// Like ssh: skips its options and the host, and runs the rest as one shell
// command on the "server", whose tree is $STUB_TREE.
const SSH_STUB = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in -i|-o|-p|-F|-l) shift 2 ;; -*) shift ;; *) break ;; esac
done
shift
exec sh -c "$(printf '%s' "$*" | sed "s#${SERVER_TREE}#$STUB_TREE#g")"
`;

let dir;
let tree;
let log;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-disconnect-"));
  tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, "scripts"))) {
    if (f.endsWith(".sh")) fs.copyFileSync(path.join(REPO, "scripts", f), path.join(tree, "scripts", f));
  }
  fs.copyFileSync(path.join(REPO, "Caddyfile"), path.join(tree, "Caddyfile"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), SSH_STUB, { mode: 0o755 });
  log = path.join(dir, "docker.log");
  env = {
    ...process.env,
    HOME: dir,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_TREE: tree,
    DEPLOY_LOG_DIR: path.join(dir, "deploy-logs"),
  };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
const upStarted = () => calls().some((c) => / up --build -d$/.test(c));
// The last thing deploy.sh does here: the stub's Caddyfile never matches.
const deployDone = () => calls().some((c) => / restart caddy$/.test(c));

async function waitFor(cond, ms = 10000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// A step's command as GitHub runs it (bash -eo pipefail), in its own process
// group, like an ssh session.
const BASH = ["--noprofile", "--norc", "-eo", "pipefail", "-c"];
function startStep(name, extraEnv = {}, cwd = REPO) {
  return spawn("bash", [...BASH, step("deploy", name).run], {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}
function runStep(name, extraEnv = {}, cwd = REPO) {
  return spawnSync("bash", [...BASH, step("deploy", name).run], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
}
const exited = (child) =>
  new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("exit", resolve)));

describe("Build & restart services", () => {
  // The runner's end of the connection goes away mid-`up`: the session's
  // pipes close (output from then on gets SIGPIPE), and anything left in its
  // process group is hung up on.
  test("the deploy finishes on the server when the connection drops mid-deploy", async () => {
    const child = startStep("Build & restart services", { STUB_UP_SLEEP: "1" });
    expect(await waitFor(upStarted)).toBe(true);
    child.stdout.destroy();
    child.stderr.destroy();
    try {
      process.kill(-child.pid, "SIGHUP");
    } catch {
      // already gone
    }

    const finished = await waitFor(deployDone);
    expect(calls().filter((c) => c === "rm -f mailpit123")).toHaveLength(2);
    expect(finished).toBe(true);
  }, 20000);

  test("passes on the deploy's output and its exit status", () => {
    const ok = runStep("Build & restart services");
    expect(ok.stdout).toContain("Caddyfile changed");
    expect(ok.status).toBe(0);
    expect(deployDone()).toBe(true);

    const failed = runStep("Build & restart services", { STUB_COMPOSE_EXIT: "1" });
    expect(failed.status).not.toBe(0);
  });

  test("keeps each deploy's log on the server", () => {
    runStep("Build & restart services");
    const logs = fs.readdirSync(env.DEPLOY_LOG_DIR);
    expect(logs).toHaveLength(1);
    expect(fs.readFileSync(path.join(env.DEPLOY_LOG_DIR, logs[0]), "utf8")).toContain("Caddyfile changed");
  });
});

describe("one deploy at a time", () => {
  // The deploy CI lost contact with keeps running; the next job's rsync must
  // not rewrite the tree under it.
  test("the next rsync waits for a deploy that is still running", async () => {
    const deploy = startStep("Build & restart services", { STUB_UP_SLEEP: "2" });
    try {
      expect(await waitFor(upStarted)).toBe(true);
      const src = path.join(dir, "checkout");
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, "marker"), "new tree\n");
      const rsync = startStep("Rsync to server", {}, src);
      expect(await exited(rsync)).toBe(0);
      expect(deployDone()).toBe(true);
      expect(fs.existsSync(path.join(tree, "marker"))).toBe(true);
    } finally {
      await exited(deploy);
    }
  }, 20000);

  test("deploy.sh waits for the tree's lock, and gives up with a message", async () => {
    const holder = spawn("flock", [tree, "sh", "-c", "echo locked; sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise((resolve) => holder.stdout.once("data", resolve));
      const r = spawnSync("sh", [path.join(tree, "scripts/deploy.sh")], {
        env: { ...env, DEPLOY_LOCK_WAIT: "1" },
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/another deploy/i);
      expect(calls()).toEqual([]);
    } finally {
      holder.kill();
      await exited(holder);
    }
  });

  // A server-side rsync whose client was black-holed holds the lock until
  // sshd notices (about 15 minutes; rsync's own --timeout doesn't fire while
  // its writes still fit the socket buffer). So the server-side rsync has a
  // time limit of its own, and the wait for the lock outlasts it.
  test("rsync's lock wait outlasts a lost rsync still holding the lock", () => {
    const run = step("deploy", "Rsync to server").run;
    const m = run.match(/--rsync-path="flock -w (\d+) \/opt\/vaalikone timeout (\d+) rsync"/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(Number(m[2]));
  });
});
