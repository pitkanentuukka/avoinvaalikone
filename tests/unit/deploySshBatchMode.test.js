// The deploy job's ssh and rsync must never ask for a password or a key's
// passphrase (issue #221). When key authentication fails, ssh falls back to
// asking; in CI that fails only because there is no terminal to ask on, and
// with one (a self-hosted runner, the commands run by hand) the step would
// wait for input until the job's timeout. BatchMode makes ssh fail at once.
const { SERVER, runSetupSsh, sshOptions, CONNECTING_STEPS, connectingStepArgs } = require("../helpers/deploySsh");

// Any well-formed ed25519 key will do: these tests never connect.
const PINNED_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

function setup() {
  return runSetupSsh({ vars: { SSH_KNOWN_HOSTS: `${SERVER} ssh-ed25519 ${PINNED_KEY}` } });
}

describe("the steps that connect", () => {
  test.each(CONNECTING_STEPS)("%s never prompts for a password or passphrase", (name) => {
    const args = connectingStepArgs(name);
    expect(args).toBeDefined();
    const h = setup();
    try {
      expect(h.result.status).toBe(0);
      expect(sshOptions(h, { args }).batchmode).toBe("yes");
    } finally {
      h.cleanup();
    }
  });

  // ssh reads /etc/ssh/ssh_config after the step's config and takes each
  // option's first value, so the step's setting must be there to win.
  test.each(CONNECTING_STEPS)("%s: the runner's system config can't turn prompting back on", (name) => {
    const h = setup();
    try {
      expect(h.result.status).toBe(0);
      const options = sshOptions(h, { args: connectingStepArgs(name), after: "Host *\n  BatchMode no\n" });
      expect(options.batchmode).toBe("yes");
    } finally {
      h.cleanup();
    }
  });
});
