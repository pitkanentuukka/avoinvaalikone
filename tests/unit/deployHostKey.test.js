// The deploy job must check the server's SSH host key against a pinned one,
// not trust whatever answers at its address (issue #206): rsync sends the
// whole tree to that host, and the next step runs deploy.sh there as root.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step } = require("../helpers/workflow");
const { SERVER, hostKeyLine, runSetupSsh, sshOptions, acceptedHostKeys } = require("../helpers/deploySsh");

let keys;
let real;
let impostor;
beforeAll(() => {
  keys = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hostkeys-"));
  real = hostKeyLine(keys, "real");
  impostor = hostKeyLine(keys, "impostor");
});
afterAll(() => fs.rmSync(keys, { recursive: true, force: true }));

const keyOf = (line) => line.split(" ").slice(1).join(" ");

// Someone in the network path answers at the server's address.
function setupWithImpostor(vars = { SSH_KNOWN_HOSTS: real }) {
  return runSetupSsh({ vars, scanned: impostor });
}

describe("Set up SSH", () => {
  test("trusts only the pinned host key, not the one presented at deploy time", () => {
    const h = setupWithImpostor();
    try {
      expect(h.result.stderr).toBe("");
      expect(h.result.status).toBe(0);
      expect(acceptedHostKeys(h)).toEqual([keyOf(real)]);
      expect(h.keyscanRan).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("ssh refuses a host whose key isn't the pinned one, rather than asking or adding it", () => {
    const h = setupWithImpostor();
    try {
      expect(h.result.status).toBe(0);
      const options = sshOptions(h);
      expect(options.stricthostkeychecking).toBe("true");
      // Exactly the pinned file: acceptedHostKeys() skips files that don't
      // exist, and a system-wide one that is missing here may not be on the
      // runner.
      expect(options.userknownhostsfile).toEqual([path.join(h.dir, ".ssh/known_hosts_deploy")]);
      expect(options.globalknownhostsfile).toEqual(["none"]);
    } finally {
      h.cleanup();
    }
  });

  // ssh takes each option's first value, so a block already in the config
  // would win over the one the step adds.
  test("a ~/.ssh/config already on the runner can't turn the check off", () => {
    const h = runSetupSsh({
      vars: { SSH_KNOWN_HOSTS: real },
      scanned: impostor,
      sshConfig: "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n",
    });
    try {
      expect(h.result.status).toBe(0);
      const options = sshOptions(h);
      expect(options.stricthostkeychecking).toBe("true");
      expect(options.userknownhostsfile).toEqual([path.join(h.dir, ".ssh/known_hosts_deploy")]);
    } finally {
      h.cleanup();
    }
  });

  test("the step reads the pinned key from a variable, through env rather than inline", () => {
    const s = step("deploy", "Set up SSH");
    expect(s.env?.SSH_KNOWN_HOSTS).toMatch(/^\$\{\{\s*vars\.SSH_KNOWN_HOSTS\s*\}\}$/);
    expect(s.run).not.toMatch(/ssh-keyscan/);
    expect(s.run).not.toMatch(/\$\{\{\s*vars\./);
  });

  // Without this, the rsync step's "Host key verification failed" would be
  // the first sign, and it doesn't say the variable is missing.
  function expectFailsNamingVariable(value) {
    const h = setupWithImpostor({ SSH_KNOWN_HOSTS: value });
    try {
      expect(h.result.status).not.toBe(0);
      expect(h.result.stdout + h.result.stderr).toMatch(/::error::.*SSH_KNOWN_HOSTS/);
      expect(h.keyscanRan).toBe(false);
    } finally {
      h.cleanup();
    }
  }

  test("fails, naming the variable, when it is unset", () => {
    expectFailsNamingVariable("");
  });

  test("fails, naming the variable, when it has no key for the server", () => {
    expectFailsNamingVariable(hostKeyLine(keys, "other", "192.0.2.1"));
  });

  // A bad paste names the right host, but ssh could never match its key.
  test("fails, naming the variable, when its key for the server doesn't parse", () => {
    expectFailsNamingVariable(`${SERVER} ssh-ed25519 notbase64`);
  });

  // The runbook compares this with the key on the server.
  test("logs the pinned key's fingerprint", () => {
    const h = setupWithImpostor();
    try {
      expect(h.result.status).toBe(0);
      const fingerprint = spawnSync("ssh-keygen", ["-lf", "-"], { input: real, encoding: "utf8" })
        .stdout.split(" ")[1];
      expect(fingerprint).toMatch(/^SHA256:/);
      expect(h.result.stdout).toContain(fingerprint);
    } finally {
      h.cleanup();
    }
  });
});

test("the steps that use ssh connect to the host the pinned key is for", () => {
  for (const name of ["Rsync to server", "Build & restart services"]) {
    expect(step("deploy", name).run).toContain(`root@${SERVER}`);
  }
});

// Rotating the server's host key breaks deploys until the variable is
// updated; the runbook must say what that failure looks like.
test("docs/runbook.md covers a host key mismatch and where the pinned key lives", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../docs/runbook.md"), "utf8");
  expect(runbook).toContain("Host key verification failed.");
  expect(runbook).toContain("SSH_KNOWN_HOSTS");
});
