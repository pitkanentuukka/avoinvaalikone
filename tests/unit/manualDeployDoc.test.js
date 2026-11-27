// docs/scaling.md's manual deploy must rsync what CI's "Rsync to server" step
// does. With fewer excludes it uploaded untracked local files to the server,
// and without --delete files removed from the repo piled up there. It must
// also take the same deploy lock (#205).
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step } = require("../helpers/workflow");

const DOC = path.join(__dirname, "../../docs/scaling.md");

// The rsync command (backslash-continued lines joined) from a shell snippet.
function rsyncCommand(text) {
  const joined = text.replace(/\\\n\s*/g, " ");
  const line = joined.split("\n").find((l) => /^\s*rsync\s/.test(l));
  if (!line) throw new Error("no rsync command found");
  return line;
}

const excludes = (cmd) => [...cmd.matchAll(/--exclude=(?:'([^']*)'|"([^"]*)"|(\S+))/g)].map((m) => m[1] ?? m[2] ?? m[3]).sort();
const rsyncPath = (cmd) => cmd.match(/--rsync-path="([^"]*)"/)?.[1];
const hasDelete = (cmd) => /\s--delete(\s|$)/.test(cmd);
// The bundled short options right after `rsync` (-az).
const shortFlags = (cmd) => cmd.match(/^\s*rsync\s+-([a-zA-Z]+)\s/)?.[1] ?? "";

function manualBlock() {
  const doc = fs.readFileSync(DOC, "utf8");
  const section = doc.split("### 1. Deploy the code")[1];
  return section.match(/```bash\n([\s\S]*?)```/)[1];
}
const manualRsync = () => rsyncCommand(manualBlock());

describe("docs/scaling.md manual deploy", () => {
  const ci = rsyncCommand(step("deploy", "Rsync to server").run);
  const manual = manualRsync();

  test("excludes what CI's rsync excludes", () => {
    expect(excludes(manual)).toEqual(excludes(ci));
  });

  test("deletes what was removed from the repo, as CI does", () => {
    expect(hasDelete(ci)).toBe(true);
    expect(hasDelete(manual)).toBe(true);
  });

  test("archives and compresses as CI does", () => {
    for (const f of shortFlags(ci)) expect(shortFlags(manual)).toContain(f);
  });

  test("takes the same deploy lock", () => {
    expect(rsyncPath(ci)).toBeTruthy();
    expect(rsyncPath(manual)).toBe(rsyncPath(ci));
  });

  // Pasted as a whole. After an rsync that gave up on the lock, or was cut
  // short, the deploy would build the old, or a half-synced, tree.
  test.each([
    [0, true],
    [12, false],
  ])("rsync exits %i: deploys %s", (exit, deploys) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-deploy-"));
    try {
      const log = path.join(dir, "ssh.log");
      fs.writeFileSync(path.join(dir, "rsync"), `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "ssh"), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
      const r = spawnSync("bash", [], {
        input: manualBlock(),
        cwd: dir,
        env: { ...process.env, LC_ALL: "C", PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(r.stderr).toBe("");
      const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      expect(/deploy-detached\.sh/.test(calls)).toBe(deploys);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// What the commands leave out, run for real between two local directories.
// Comparing the two exclude lists can't show that both miss something: they
// missed .env.docker, which holds secrets.
describe.each([
  ["CI's rsync", () => rsyncCommand(step("deploy", "Rsync to server").run)],
  ["docs/scaling.md's rsync", manualRsync],
])("%s", (_name, command) => {
  const REPO = path.join(__dirname, "../..");
  // Files git ignores, from the repo's own .gitignore files.
  const IGNORED = [
    ".env",
    ".env.docker",
    ".env.local",
    "server.pem",
    "debug.log",
    "coverage/lcov.info",
    "test-results/report.json",
    "node_modules/pkg/index.js",
    "vaalikone-frontend/.env",
    "vaalikone-frontend/.env.production.local",
    "vaalikone-frontend/dist/index.html",
  ];
  const SENT = ["package.json", ".env.example", "src/index.js", "vaalikone-frontend/src/App.jsx"];
  // Ignored files an earlier deploy left on the server.
  const STALE = [".env.docker", "old.pem", "vaalikone-frontend/dist/old.js"];
  let dir;
  const write = (root, f, text = f) => {
    const p = path.join(dir, root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const at = (root, f) => path.join(dir, root, f);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-deploy-"));
    for (const f of [...IGNORED, ...SENT]) write("checkout", f);
    for (const f of [".gitignore", "vaalikone-frontend/.gitignore"]) {
      const text = fs.readFileSync(path.join(REPO, f), "utf8");
      write("checkout", f, text);
      write("server", f, text);
    }
    for (const f of STALE) write("server", f, "stale");
    write("server", ".env", "production settings");
    write("server", "src/removed.js");
    run("checkout");
  });

  // The same command, without ssh: to a local directory.
  function run(from) {
    const local = command()
      .replace(/\s-e "[^"]*"/, "")
      .replace(/--rsync-path="[^"]*"/, "")
      .replace(/\S+@\S+:\S+/, '"$DEST"')
      .replace(/\s*(\|\||&&)\s*$/, "");
    const res = spawnSync("bash", ["-c", local], {
      cwd: path.join(dir, from),
      env: { ...process.env, LC_ALL: "C", DEST: path.join(dir, "server") },
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  }

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("sends the repo's files and no file git ignores", () => {
    expect(SENT.filter((f) => !fs.existsSync(at("server", f)))).toEqual([]);
    const sent = IGNORED.filter((f) => fs.existsSync(at("server", f)) && fs.readFileSync(at("server", f), "utf8") === f);
    expect(sent).toEqual([]);
  });

  test("keeps the server's .env and deletes what the repo no longer has", () => {
    expect(fs.readFileSync(at("server", ".env"), "utf8")).toBe("production settings");
    expect(fs.existsSync(at("server", "src/removed.js"))).toBe(false);
  });

  // Ignored or not: one could hold secrets, as .env.docker does.
  test("deletes ignored files from the server, except those excluded by name", () => {
    expect(STALE.filter((f) => fs.existsSync(at("server", f)))).toEqual([]);
  });

  // rsync reads .gitignore without git's `!` negations, and git tracks files
  // it would ignore: a tracked file could silently stop being deployed.
  test("sends every tracked file", () => {
    const ls = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
    expect(ls.status).toBe(0);
    const tracked = ls.stdout.split("\0").filter((f) => f && fs.existsSync(path.join(REPO, f)));
    expect(tracked.length).toBeGreaterThan(50);
    for (const f of tracked) {
      fs.mkdirSync(path.dirname(at("tracked", f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, f), at("tracked", f));
    }
    run("tracked");
    const missing = tracked.filter((f) => !fs.existsSync(at("server", f)) && !/^\.(github|claude)\//.test(f));
    // Matches .gitignore's .env.docker; nothing on the server uses it.
    expect(missing).toEqual(["vaalikone-frontend/.env.docker"]);
  });
});
