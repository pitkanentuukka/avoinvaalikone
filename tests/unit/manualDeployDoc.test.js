// docs/scaling.md's manual deploy must rsync what CI's "Rsync to server" step
// does. With fewer excludes it uploaded untracked local files to the server,
// and without --delete files removed from the repo piled up there. It must
// also take the same deploy lock (#205).
const fs = require("fs");
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

function manualRsync() {
  const doc = fs.readFileSync(DOC, "utf8");
  const section = doc.split("### 1. Deploy the code")[1];
  const block = section.match(/```bash\n([\s\S]*?)```/)[1];
  return rsyncCommand(block);
}

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
});
