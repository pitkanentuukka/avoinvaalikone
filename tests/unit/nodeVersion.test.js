// CI and both Docker images must run a Node release that still gets
// security fixes (issue #174: they stayed on Node 20 past its April 2026
// end-of-life). The versions are read from the files themselves, so a bump
// that misses one of them fails here, and so does a release that has since
// reached end-of-life.
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
    expect(where.filter((w) => w === ".github/workflows/ci-cd.yml")).toHaveLength(2);
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
