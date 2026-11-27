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
exec sh -c "$(printf '%s' "$*" | sed "s#${SERVER_TREE}#'$STUB_TREE'#g")"
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
    // A locale that isn't installed makes bash warn on stderr.
    LC_ALL: "C",
    HOME: dir,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_TREE: tree,
    DEPLOY_LOG_DIR: path.join(dir, "deploy-logs"),
  };
  // The log-directory fallback must land under this HOME, not the developer's.
  delete env.XDG_STATE_HOME;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
const upStarted = () => calls().some((c) => / up -d$/.test(c));
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

// A step's command as GitHub runs one without `shell:` (bash -e, without
// pipefail), in its own process group, like an ssh session.
const BASH = ["-e", "-c"];
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
    const child = startStep("Build & restart services", { STUB_UP_SLEEP: "3" });
    expect(await waitFor(upStarted)).toBe(true);
    expect(deployDone()).toBe(false);
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

  // Its first write to the closed pipe must not come before the deploy.
  test("the deploy runs even if the connection is gone before it starts", async () => {
    const script = path.join(tree, "scripts/deploy-detached.sh");
    spawnSync("bash", ["-c", '{ sleep 0.5; sh "$1"; } | :', "bash", script], { env });
    expect(await waitFor(deployDone)).toBe(true);
  }, 20000);

  test("a hangup that does reach the deploy's session doesn't stop it", async () => {
    const child = startStep("Build & restart services", { STUB_UP_SLEEP: "3" });
    const ended = exited(child);
    try {
      expect(await waitFor(upStarted)).toBe(true);
      const [name] = fs.readdirSync(env.DEPLOY_LOG_DIR);
      const text = fs.readFileSync(path.join(env.DEPLOY_LOG_DIR, name), "utf8");
      const session = text.match(/pkill -s (\d+)\)/)[1];
      expect(deployDone()).toBe(false);
      expect(spawnSync("pkill", ["-HUP", "-s", session]).status).toBe(0);
    } finally {
      expect(await ended).toBe(0);
    }
    expect(deployDone()).toBe(true);
  }, 20000);

  test("passes on the deploy's output and its exit status", () => {
    const ok = runStep("Build & restart services");
    expect(ok.stdout).toContain("Caddyfile changed");
    expect(ok.status).toBe(0);
    expect(deployDone()).toBe(true);

    const failed = runStep("Build & restart services", { STUB_COMPOSE_EXIT: "7" });
    expect(failed.status).toBe(7);
  });

  // With job control a background job leads its process group, and setsid
  // then forks: without -w, it ends at once, with status 0. (`bash -m` turns
  // job control off again without a terminal.)
  test("passes on the exit status from a shell with job control", () => {
    const r = spawnSync("bash", ["-c", 'set -m; . "$0"', path.join(tree, "scripts/deploy-detached.sh")], {
      env: { ...env, STUB_COMPOSE_EXIT: "7", STUB_UP_SLEEP: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(7);
  });

  // Only root can create the default log directory.
  const asRoot = process.getuid && process.getuid() === 0;
  (asRoot ? test.skip : test)("a user who can't write the log directory gets one of their own", () => {
    fs.mkdirSync(env.DEPLOY_LOG_DIR, { mode: 0o555 });
    const r = runStep("Build & restart services");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(fs.readdirSync(path.join(dir, ".local/state/vaalikone-deploy"))).toHaveLength(1);
  });

  test("keeps each deploy's log on the server", () => {
    runStep("Build & restart services");
    const logs = fs.readdirSync(env.DEPLOY_LOG_DIR);
    expect(logs).toHaveLength(1);
    const text = fs.readFileSync(path.join(env.DEPLOY_LOG_DIR, logs[0]), "utf8");
    expect(text).toContain("Caddyfile changed");
    // Read after losing the connection, it still tells how the deploy ended.
    expect(text.trim().split("\n").pop()).toMatch(/exit status 0$/);
  });

  // For a stuck deploy (docs/runbook.md): nothing else names it reliably.
  // lslocks doesn't, as the flock process that took the lock is gone.
  test("the log says it got the lock, and how to stop the deploy", async () => {
    const child = startStep("Build & restart services", { STUB_UP_SLEEP: "15" });
    const ended = exited(child);
    try {
      expect(await waitFor(upStarted)).toBe(true);
      const [name] = fs.readdirSync(env.DEPLOY_LOG_DIR);
      const text = fs.readFileSync(path.join(env.DEPLOY_LOG_DIR, name), "utf8");
      expect(text).toContain("Got the deploy lock");
      const session = text.match(/to stop it: pkill -s (\d+)\)/)?.[1];
      expect(session).toBeTruthy();

      const lockFree = () => spawnSync("flock", ["-n", tree, "true"]).status === 0;
      expect(lockFree()).toBe(false);
      const running = spawnSync("pgrep", ["-as", session], { encoding: "utf8" });
      expect(running.stdout).toContain("deploy.sh");
      expect(spawnSync("pkill", ["-s", session]).status).toBe(0);
      expect(await ended).not.toBe(0);
      expect(await waitFor(lockFree)).toBe(true);
      expect(deployDone()).toBe(false);
    } finally {
      await ended;
    }
  }, 30000);

  test("docs/runbook.md quotes what the log says", () => {
    const { stdout } = runStep("Build & restart services");
    const [name] = fs.readdirSync(env.DEPLOY_LOG_DIR);
    // The step's output: the log, and where it is.
    expect(stdout).toContain(`Deploy log on the server: ${path.join(env.DEPLOY_LOG_DIR, name)}`);
    const text = stdout;
    const runbook = fs.readFileSync(path.join(REPO, "docs/runbook.md"), "utf8");
    for (const line of ["Deploy log on the server:", "Got the deploy lock", "Deploy ended", "to stop it: pkill -s"]) {
      expect(text).toContain(line);
      expect(runbook).toContain(line);
    }
  });
});

describe("one deploy at a time", () => {
  // The deploy CI lost contact with keeps running; the next job's rsync must
  // not rewrite the tree under it.
  test("the next rsync waits for a deploy that is still running", async () => {
    const deploy = startStep("Build & restart services", { STUB_UP_SLEEP: "3" });
    try {
      expect(await waitFor(upStarted)).toBe(true);
      expect(deployDone()).toBe(false);
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

  // Holds the tree's lock (as a running deploy would) until released; its
  // own process group, so releasing it stops the sleep too.
  async function holdLock(seconds) {
    const holder = spawn("flock", [tree, "sh", "-c", `echo locked; sleep ${seconds}`], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    return async () => {
      try {
        process.kill(-holder.pid, "SIGTERM");
      } catch {
        // already gone
      }
      await exited(holder);
    };
  }

  test("deploy.sh waits for the tree's lock, and gives up with a message", async () => {
    const release = await holdLock(5);
    try {
      const r = spawnSync("sh", [path.join(tree, "scripts/deploy.sh")], {
        env: { ...env, DEPLOY_LOCK_WAIT: "1" },
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/Waiting for another deploy/);
      expect(r.stdout).not.toContain("Got the deploy lock");
      expect(r.stderr).toMatch(/Gave up: another deploy is still running/);
      expect(calls()).toEqual([]);
    } finally {
      await release();
    }
  });

  test("deploy.sh goes ahead once it gets the lock", async () => {
    const release = await holdLock(2);
    try {
      const r = spawnSync("sh", [path.join(tree, "scripts/deploy.sh")], {
        env: { ...env, DEPLOY_LOCK_WAIT: "20" },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Waiting for another deploy[^]*Got the deploy lock/);
      expect(deployDone()).toBe(true);
    } finally {
      await release();
    }
  }, 20000);

  // The job must not go on to deploy the old, or a half-synced, tree.
  test("the rsync step fails, with a hint, when rsync does", () => {
    fs.writeFileSync(path.join(dir, "bin/rsync"), "#!/bin/sh\nexit 12\n", { mode: 0o755 });
    const r = runStep("Rsync to server");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/^::error::rsync failed/m);
  });

  // Otherwise a wait that runs out shows in the step only as rsync's
  // "connection unexpectedly closed".
  test("rsync's wait for the lock shows in the step's log", async () => {
    const release = await holdLock(3);
    try {
      const src = path.join(dir, "checkout");
      fs.mkdirSync(src);
      const rsync = startStep("Rsync to server", {}, src);
      let stderr = "";
      rsync.stderr.on("data", (d) => (stderr += d));
      expect(await exited(rsync)).toBe(0);
      expect(stderr).toMatch(/Waiting for another deploy to finish/);
    } finally {
      await release();
    }
  }, 20000);

  // flock would create a missing path as a regular file, and the rsync into
  // it would then fail.
  test("rsync still creates a tree that isn't there yet", async () => {
    const src = path.join(dir, "checkout");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "marker"), "first deploy\n");
    const fresh = path.join(dir, "fresh/vaalikone");
    const rsync = startStep("Rsync to server", { STUB_TREE: fresh }, src);
    expect(await exited(rsync)).toBe(0);
    expect(fs.existsSync(path.join(fresh, "marker"))).toBe(true);
  }, 20000);

  // A server-side rsync whose client was black-holed holds the lock until
  // sshd notices (about 15 minutes; rsync's own --timeout doesn't fire while
  // its writes still fit the socket buffer). So the server-side rsync has a
  // time limit of its own, and the wait for the lock outlasts it.
  test("rsync's lock wait outlasts a lost rsync still holding the lock", () => {
    const run = step("deploy", "Rsync to server").run;
    const m = run.match(/--rsync-path="[^"]*\bflock -w (\d+) \/opt\/vaalikone timeout (?:-k (\d+) )?(\d+) rsync"/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(Number(m[2] ?? 0) + Number(m[3]));
  });

  // rsync's SIGTERM handler can block on its full output pipe, which nobody
  // reads any more. The workflow's own server-side command, with its time
  // limits cut to a second and an rsync that ignores SIGTERM.
  test("a lost rsync that ignores SIGTERM still frees the lock", () => {
    const remote = step("deploy", "Rsync to server").run.match(/--rsync-path="([^"]*)"/)[1];
    const quick = remote
      .replaceAll(SERVER_TREE, `'${tree}'`)
      .replace(/timeout (-k \d+ )?\d+ rsync/, (_, k) => `timeout ${k ? "-k 1 " : ""}1 rsync`);
    expect(quick).toMatch(/timeout (-k 1 )?1 rsync$/);
    fs.writeFileSync(path.join(dir, "bin/rsync"), "#!/bin/sh\ntrap '' TERM\nexec sleep 12\n", { mode: 0o755 });
    const start = Date.now();
    spawnSync("sh", ["-c", quick], { env });
    expect(Date.now() - start).toBeLessThan(8000);
    expect(spawnSync("flock", ["-n", tree, "true"]).status).toBe(0);
  }, 20000);
});
