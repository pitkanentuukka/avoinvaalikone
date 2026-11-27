// The deploy job's "Set up SSH" step writes the SSH_PRIVATE_KEY secret to a
// key file (issue #207). GitHub substitutes every `${{ … }}` into a step's
// script text before bash runs it, so a secret written there becomes code:
// a `"`, `$(…)` or backtick in it would change the file or run as a command.
// The secret must reach the script through the environment, and the file
// must never be readable by others, even before its chmod.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { workflow, step } = require("../helpers/workflow");

// What GitHub does with `${{ secrets.X }}` and `${{ vars.X }}` in a step's
// run and env: textual substitution, before the shell sees anything.
function interpolate(text, context) {
  return String(text).replace(/\$\{\{\s*(secrets|vars)\.(\w+)\s*\}\}/g, (_, kind, name) =>
    context[kind][name] ?? ""
  );
}

// Runs the step as GitHub would (bash --noprofile --norc -eo pipefail) in a
// throwaway HOME, with ssh-keyscan stubbed. `prelude` runs first, in the
// same shell.
function runSetup(secrets, { prelude = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-key-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh-keyscan"), "#!/bin/sh\necho keyscan-stub\n", { mode: 0o755 });
  const context = { secrets, vars: {} };
  const s = step("deploy", "Set up SSH");
  const stepEnv = Object.fromEntries(
    Object.entries(s.env || {}).map(([k, v]) => [k, interpolate(v, context)])
  );
  const script = prelude + interpolate(s.run, context);
  const env = { ...process.env, ...stepEnv, HOME: dir, PATH: `${bin}:${process.env.PATH}` };
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", `umask 022\n${script}`],
    { cwd: dir, env, encoding: "utf8" }
  );
  return { dir, result, keyFile: path.join(dir, ".ssh/deploy_key") };
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

describe("Set up SSH writes the deploy key", () => {
  test("byte for byte, without running any of it", () => {
    // Not a real key: one a mangled paste could produce.
    const secret = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      'b3BlbnNzaC1rZXk"; touch quoted; echo "',
      "AAAA$(touch substituted)`touch backticked`",
      "back\\slash \\n \\\\ $HOME ${HOME} 'single'",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const { dir, result, keyFile } = runSetup({ SSH_PRIVATE_KEY: secret });
    cleanups.push(dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const f of ["quoted", "substituted", "backticked"]) {
      expect(fs.existsSync(path.join(dir, f))).toBe(false);
    }
    expect(fs.readFileSync(keyFile, "utf8")).toBe(`${secret}\n`);
  });

  test("so that ssh can use a real key", () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-keygen-"));
    cleanups.push(keyDir);
    const key = path.join(keyDir, "id");
    const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key]);
    expect(gen.status).toBe(0);
    // GitHub keeps a pasted secret's text; the editor may drop the last newline.
    const secret = fs.readFileSync(key, "utf8").replace(/\n$/, "");

    const { dir, result, keyFile } = runSetup({ SSH_PRIVATE_KEY: secret });
    cleanups.push(dir);
    expect(result.status).toBe(0);
    const pub = spawnSync("ssh-keygen", ["-y", "-f", keyFile], { encoding: "utf8" });
    expect(pub.stderr).toBe("");
    // Type and key, without the comment.
    const typeAndKey = (line) => line.trim().split(/\s+/).slice(0, 2);
    expect(typeAndKey(pub.stdout)).toEqual(typeAndKey(fs.readFileSync(`${key}.pub`, "utf8")));
  });

  test("into a file only its owner can ever read", () => {
    // Before every command, record the key file's mode if it exists.
    const prelude =
      `trap '[ -e "$HOME/.ssh/deploy_key" ] && stat -c %a "$HOME/.ssh/deploy_key" >> "$HOME/modes" || true' DEBUG\n`;
    const { dir, result } = runSetup({ SSH_PRIVATE_KEY: "not-a-key" }, { prelude });
    cleanups.push(dir);
    expect(result.status).toBe(0);
    const modes = fs.readFileSync(path.join(dir, "modes"), "utf8").trim().split("\n");
    expect(modes.length).toBeGreaterThan(0);
    expect(new Set(modes)).toEqual(new Set(["600"]));
  });
});

test("no step puts a secret into its script text", () => {
  const offenders = [];
  for (const [jobName, job] of Object.entries(workflow().jobs)) {
    for (const s of job.steps || []) {
      if (/\$\{\{\s*secrets\./.test(s.run || "")) offenders.push(`${jobName}: ${s.name}`);
    }
  }
  expect(offenders).toEqual([]);
});
