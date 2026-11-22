// CI and both Docker images must run a Node release that still gets
// security fixes (issue #174: they stayed on Node 20 past its April 2026
// end-of-life). The versions are read from the files themselves, so a bump
// that misses one of them fails here. So does a release that has since
// reached end-of-life: this test starts failing on its own on that date,
// which is the reminder to move to the next LTS.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// End-of-life dates of the LTS lines, from https://nodejs.org/en/about/previous-releases.
// Moving to a release not listed here means adding its date.
const LTS_END_OF_LIFE = {
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
};

function nodeMajors() {
  const majors = [];
  for (const m of read(".github/workflows/ci-cd.yml").matchAll(/node-version:\s*["']?(\d+)/g)) {
    majors.push({ where: ".github/workflows/ci-cd.yml", major: Number(m[1]) });
  }
  for (const file of ["Dockerfile", "vaalikone-frontend/Dockerfile"]) {
    for (const m of read(file).matchAll(/^FROM\s+node:(\d+)/gim)) {
      majors.push({ where: file, major: Number(m[1]) });
    }
  }
  return majors;
}

describe("Node.js runtime version", () => {
  const majors = nodeMajors();

  test("CI jobs and both Dockerfiles each pin a Node version", () => {
    const where = majors.map((m) => m.where);
    expect(where).toContain(".github/workflows/ci-cd.yml");
    expect(where).toContain("Dockerfile");
    expect(where).toContain("vaalikone-frontend/Dockerfile");
  });

  // CI has to test the same runtime the images ship.
  test("all of them use the same major version", () => {
    expect(new Set(majors.map((m) => m.major)).size).toBe(1);
  });

  test.each(majors.map((m) => [m.where, m.major]))("%s uses a supported LTS release (Node %i)", (_where, major) => {
    const eol = LTS_END_OF_LIFE[major];
    expect(eol).toBeDefined();
    expect(Date.now()).toBeLessThan(new Date(`${eol}T23:59:59Z`).getTime());
  });
});

// The workflow's actions run on a Node runtime of their own, named in each
// action's action.yml (`using: node20`). These majors still run on Node 20.
const NODE20_ACTION_MAJORS = {
  "actions/checkout": 4,
  "actions/setup-node": 4,
  "actions/upload-artifact": 5,
};

describe("GitHub Actions runtime", () => {
  const uses = [...read(".github/workflows/ci-cd.yml").matchAll(/uses:\s*([\w-]+\/[\w-]+)@v(\d+)/g)].map((m) => [
    m[1],
    Number(m[2]),
  ]);

  test("the workflow uses actions", () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  test.each(uses)("%s@v%i does not run on the Node 20 action runtime", (action, major) => {
    const lastNode20 = NODE20_ACTION_MAJORS[action];
    if (lastNode20 !== undefined) expect(major).toBeGreaterThan(lastNode20);
  });
});
