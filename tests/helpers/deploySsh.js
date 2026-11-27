// Runs the deploy job's "Set up SSH" step against a throwaway HOME, and asks
// ssh what it would do with the config the step writes. rsync's `-e ssh`
// reads the same config.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step } = require("./workflow");

const SERVER = "80.69.172.220";

// A host key line, as `ssh-keyscan -t ed25519` prints one, for a fresh key.
function hostKeyLine(dir, name, host = SERVER) {
  const file = path.join(dir, name);
  const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
  if (gen.status !== 0) throw new Error(`ssh-keygen failed: ${gen.stderr}`);
  const [type, key] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ");
  return `${host} ${type} ${key}`;
}

// `vars` gives the values of the step's `${{ vars.X }}` and `${{ secrets.X }}`
// expressions, by name; others are blank. `ssh-keyscan` is stubbed to answer
// with `scanned` (the key whoever answers at that address presents), and
// records that it ran.
function runSetupSsh({ vars = {}, scanned = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ssh-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const scanLog = path.join(dir, "keyscan-ran");
  fs.writeFileSync(
    path.join(bin, "ssh-keyscan"),
    `#!/bin/sh\necho "$@" >> '${scanLog}'\nprintf '%s\\n' '${scanned}'\n`,
    { mode: 0o755 }
  );
  const s = step("deploy", "Set up SSH");
  const expand = (v) =>
    String(v).replace(/\$\{\{\s*(?:vars|secrets)\.(\w+)\s*\}\}/g, (_, name) => vars[name] ?? "");
  const stepEnv = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, expand(v)]));
  const script = expand(s.run).replace(/\$\{\{[^}]*\}\}/g, "");
  const env = { ...process.env, ...stepEnv, HOME: dir, PATH: `${bin}:${process.env.PATH}` };
  const result = spawnSync("bash", ["-e", "-c", script], { env, encoding: "utf8" });
  return {
    dir,
    env,
    result,
    keyscanRan: fs.existsSync(scanLog),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ssh's effective options for the server, under the config the step wrote.
// Options ssh lists several times (known-hosts files) come back as arrays.
function sshOptions({ dir, env }) {
  const config = path.join(dir, ".ssh/config");
  const ssh = spawnSync("ssh", ["-G", "-F", config, `root@${SERVER}`], { env, encoding: "utf8" });
  if (ssh.status !== 0) throw new Error(`ssh -G failed: ${ssh.stderr}`);
  const options = {};
  for (const line of ssh.stdout.split("\n").filter(Boolean)) {
    const i = line.indexOf(" ");
    const [k, v] = [line.slice(0, i), line.slice(i + 1)];
    if (k === "userknownhostsfile" || k === "globalknownhostsfile") {
      options[k] = [...(options[k] || []), ...v.split(" ")];
    } else {
      options[k] = v;
    }
  }
  return options;
}

// Every key ssh would accept for the server: the server's entries in each
// known-hosts file ssh consults, found the way ssh looks them up (hashed or
// not). ssh expands `~` from the passwd entry, not $HOME, so a config that
// names `~/...` points this at the real home's files, as it would ssh.
function acceptedHostKeys(handle) {
  const options = sshOptions(handle);
  const files = [...options.userknownhostsfile, ...options.globalknownhostsfile];
  const keys = [];
  for (const file of files) {
    if (file === "none" || !fs.existsSync(file)) continue;
    const found = spawnSync("ssh-keygen", ["-F", SERVER, "-f", file], { encoding: "utf8" });
    for (const line of found.stdout.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [, type, key] = line.split(" ");
      keys.push(`${type} ${key}`);
    }
  }
  return keys;
}

module.exports = { SERVER, hostKeyLine, runSetupSsh, sshOptions, acceptedHostKeys };
