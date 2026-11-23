// CI must build what the deploy builds (issue #202). `scripts/deploy.sh` runs
// `docker compose up --build` on the server after the merge, so a change that
// broke `vite build` or a Dockerfile stage passed CI and failed only there.
// The workflow and compose files are read as text: the workflow is 2-space
// YAML, split here into jobs and steps by indentation.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const WORKFLOW = read(".github/workflows/ci-cd.yml");

function parseJobs() {
  const body = WORKFLOW.split(/^jobs:\n/m)[1];
  const jobs = {};
  for (const m of body.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)) {
    const [, name, text] = m;
    const stepsText = text.split(/^ {4}steps:\n/m)[1] || "";
    jobs[name] = {
      text,
      steps: stepsText.split(/^ {6}- /m).slice(1),
      needs: (text.match(/^ {4}needs:\s*\[([^\]]*)\]/m)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean),
      conditional: /^ {4}if:/m.test(text),
    };
  }
  return jobs;
}

// The step's shell commands, `\` continuations joined.
function runOf(step) {
  const m = step.match(/^(?: {8})?run:\s*(\|\n((?: {10}.*|)\n)*|.*)/m);
  if (!m) return "";
  return m[1].replace(/^\|\n/, "").replace(/\\\n\s*/g, " ");
}

const workingDirOf = (step) => step.match(/^ {8}working-directory:\s*(\S+)/m)?.[1] || ".";

const normalise = (p) => path.posix.normalize(p).replace(/\/$/, "");

// Every `docker build` / `docker buildx build` in the step: { context, dockerfile }.
function dockerBuildsIn(step) {
  const cwd = workingDirOf(step);
  const builds = [];
  for (const line of runOf(step).split("\n")) {
    const m = line.match(/\bdocker\s+(?:buildx\s+)?build\s+(.*)/);
    if (!m) continue;
    const args = m[1].split(/\s+/).filter(Boolean);
    let file;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-f" || a === "--file") file = args[++i];
      else if (a.startsWith("--file=")) file = a.slice("--file=".length);
      else if (/^(-t|--tag|--build-arg|--target|--platform|--label|--cache-from|--cache-to|-o|--output)$/.test(a)) i++;
      else if (!a.startsWith("-")) positional.push(a);
    }
    const context = normalise(path.posix.join(cwd, positional[positional.length - 1] || "."));
    const dockerfile = normalise(file ? path.posix.join(cwd, file) : path.posix.join(context, "Dockerfile"));
    builds.push({ context, dockerfile });
  }
  return builds;
}

// Every image a compose file builds: { context, dockerfile }, relative to the repo root.
function composeBuilds(file) {
  const builds = [];
  for (const m of read(file).matchAll(/^ {4}build:(.*)\n((?: {6}.*\n)*)/gm)) {
    const inline = m[1].trim();
    const context = normalise(inline || m[2].match(/^ {6}context:\s*(\S+)/m)[1]);
    const dockerfile = m[2].match(/^ {6}dockerfile:\s*(\S+)/m)?.[1] || "Dockerfile";
    builds.push({ context, dockerfile: normalise(path.posix.join(context, dockerfile)) });
  }
  return builds;
}

const jobs = parseJobs();
const unconditional = Object.entries(jobs).filter(([, job]) => !job.conditional);
const deployNeeds = jobs.deploy.needs;

describe("CI builds what the deploy builds", () => {
  test("the workflow runs on pull requests", () => {
    expect(WORKFLOW).toMatch(/^on:\n(?: {2}.*\n)*? {2}pull_request:/m);
  });

  test("the parser finds the jobs and their steps", () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["lint-and-unit", "e2e-api", "deploy"]));
    expect(jobs["lint-and-unit"].steps.some((s) => runOf(s).includes("npm run lint"))).toBe(true);
  });

  test("a job on every PR builds the frontend, and the deploy waits for it", () => {
    const building = unconditional.filter(([, job]) =>
      job.steps.some((s) => workingDirOf(s) === "vaalikone-frontend" && /\bnpm run build\b/.test(runOf(s))),
    );
    expect(building.map(([name]) => name)).not.toEqual([]);
    for (const [name] of building) expect(deployNeeds).toContain(name);
  });

  const images = [...composeBuilds("docker-compose.yml"), ...composeBuilds("docker-compose.prod.yml")];

  test("the compose files build the backend, frontend and backup images", () => {
    expect(images.map((i) => i.dockerfile).sort()).toEqual([
      "Dockerfile",
      "scripts/backup/Dockerfile",
      "vaalikone-frontend/Dockerfile",
    ]);
  });

  test.each(images.map((i) => [i.dockerfile, i]))(
    "a job on every PR builds %s with its compose context, and the deploy waits for it",
    (_dockerfile, image) => {
      const building = unconditional.filter(([, job]) =>
        job.steps.some((s) => dockerBuildsIn(s).some((b) => b.context === image.context && b.dockerfile === image.dockerfile)),
      );
      expect(building.map(([name]) => name)).not.toEqual([]);
      for (const [name] of building) expect(deployNeeds).toContain(name);
    },
  );
});
