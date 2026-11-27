// CI must build what the deploy builds (issue #202). `scripts/deploy.sh` runs
// `docker compose up --build` on the server after the merge, so a change that
// broke `vite build` or a Dockerfile stage passed CI and failed only there.
// The workflow and compose files are read as text: the workflow is 2-space
// YAML, split here into jobs and steps by indentation. Build args are not
// compared: compose passes the frontend's defaults, which the Dockerfile has
// too. A build CI only runs sometimes, or whose failure it ignores, doesn't
// count, so the build steps and their jobs must be unconditional.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const WORKFLOW = read(".github/workflows/ci-cd.yml");

function parseJobs() {
  const body = WORKFLOW.split(/^jobs:\n/m)[1] || "";
  const jobs = {};
  for (const m of body.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)) {
    const [, name, text] = m;
    const stepsText = text.split(/^ {4}steps:\n/m)[1] || "";
    jobs[name] = {
      name,
      text,
      steps: stepsText.split(/^ {6}- /m).slice(1),
      needs: (text.match(/^ {4}needs:\s*\[([^\]]*)\]/m)?.[1] ?? text.match(/^ {4}needs:\s*(\S+)/m)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  return jobs;
}

// A key of the step (the first one sits right after the `- `).
const stepKey = (step, key) => step.match(new RegExp(`^(?: {8})?${key}:\\s*(.*)`, "m"))?.[1];

// The step's shell commands: block scalars (`|`, `>`, with chomping) and quoted
// one-liners, `\` continuations joined, comment lines dropped.
function runOf(step) {
  const m = step.match(/^(?: {8})?run:[ \t]*(?:([|>][-+]?)[ \t]*\n((?:(?: {10}.*)?\n)*)|(.*))/m);
  if (!m) return "";
  const text = m[2] !== undefined ? m[2] : m[3].trim().replace(/^(["'])(.*)\1$/, "$2");
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const normalise = (p) => path.posix.normalize(p).replace(/(.)\/$/, "$1");

const workingDirOf = (step) => normalise(stepKey(step, "working-directory") || ".");

// `docker build` options that take a value as the next argument.
const VALUE_OPTIONS = new Set(
  "-t --tag --build-arg --target --platform --label --cache-from --cache-to -o --output --progress --network --secret --ssh --build-context --iidfile --metadata-file --shm-size -m --memory --add-host --ulimit --annotation --attest --builder --allow".split(
    " ",
  ),
);

// Every `docker build` / `docker buildx build` in the step: { context, dockerfile, target }.
function dockerBuildsIn(step) {
  const cwd = workingDirOf(step);
  const builds = [];
  for (const line of runOf(step).split("\n")) {
    const m = line.match(/\bdocker\s+(?:buildx\s+)?build\s+(.*)/);
    if (!m) continue;
    const args = m[1].split(/\s*(?:&&|\|\||;|\|)\s*/)[0].split(/\s+/).filter(Boolean);
    let file;
    let target;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const [opt, inlineValue] = args[i].split(/=(.*)/s);
      const value = () => (inlineValue !== undefined ? inlineValue : args[++i]);
      if (opt === "-f" || opt === "--file") file = value();
      else if (opt === "--target") target = value();
      else if (VALUE_OPTIONS.has(opt)) value();
      else if (!args[i].startsWith("-")) positional.push(args[i]);
    }
    const context = normalise(path.posix.join(cwd, positional[0] || "."));
    const dockerfile = normalise(file ? path.posix.join(cwd, file) : path.posix.join(context, "Dockerfile"));
    builds.push({ context, dockerfile, target });
  }
  return builds;
}

// Every image a compose file builds: { context, dockerfile, target }, relative to the repo root.
function composeBuilds(file) {
  const builds = [];
  for (const m of read(file).matchAll(/^ {4}build:(.*)\n((?: {6}.*\n)*)/gm)) {
    const inline = m[1].trim();
    const context = normalise(inline || m[2].match(/^ {6}context:\s*(\S+)/m)?.[1] || ".");
    const dockerfile = m[2].match(/^ {6}dockerfile:\s*(\S+)/m)?.[1] || "Dockerfile";
    const target = m[2].match(/^ {6}target:\s*(\S+)/m)?.[1];
    builds.push({ context, dockerfile: normalise(path.posix.join(context, dockerfile)), target });
  }
  return builds;
}

const jobs = parseJobs();

// [job, step] for every step that `matches`.
const stepsWhere = (matches) => Object.values(jobs).flatMap((job) => job.steps.filter(matches).map((step) => [job, step]));

// Each step must run on every PR and push, fail its job when it fails, and
// gate the deploy.
function expectGatesDeploy(found) {
  expect(found.map(([job]) => job.name)).not.toEqual([]);
  for (const [job, step] of found) {
    expect({ job: job.name, if: /^ {4}if:/m.test(job.text) }).toEqual({ job: job.name, if: false });
    expect({ job: job.name, continueOnError: /^ {4}continue-on-error:/m.test(job.text) }).toEqual({
      job: job.name,
      continueOnError: false,
    });
    expect({ step: stepKey(step, "name"), if: stepKey(step, "if") }).toEqual({ step: stepKey(step, "name"), if: undefined });
    expect({ step: stepKey(step, "name"), continueOnError: stepKey(step, "continue-on-error") }).toEqual({
      step: stepKey(step, "name"),
      continueOnError: undefined,
    });
    expect(job.needs).not.toContain("deploy");
    expect(jobs.deploy.needs).toContain(job.name);
  }
}

describe("CI builds what the deploy builds", () => {
  // No branch or path filters: every PR gets the builds.
  test("the workflow runs on every pull request", () => {
    expect(WORKFLOW).toMatch(/^on:\n(?: {2}.*\n)*? {2}pull_request:\s*\n(?! {4})/m);
  });

  test("the parser finds the jobs and their steps", () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["lint-and-unit", "e2e-api", "deploy"]));
    expect(jobs["lint-and-unit"].steps.some((s) => runOf(s).includes("npm run lint"))).toBe(true);
  });

  test("the parser reads docker build commands", () => {
    const step = (run, extra = "") => `name: x\n${extra}        run: ${run}\n`;
    expect(dockerBuildsIn(step("docker build . --progress plain"))).toEqual([
      { context: ".", dockerfile: "Dockerfile", target: undefined },
    ]);
    expect(dockerBuildsIn(step("docker build -t x --target=build ./vaalikone-frontend/ && echo ok"))).toEqual([
      { context: "vaalikone-frontend", dockerfile: "vaalikone-frontend/Dockerfile", target: "build" },
    ]);
    expect(dockerBuildsIn(step("|-\n          docker build \\\n            -f backup/Dockerfile backup", "        working-directory: ./scripts\n"))).toEqual([
      { context: "scripts/backup", dockerfile: "scripts/backup/Dockerfile", target: undefined },
    ]);
    expect(dockerBuildsIn(step("|\n          # docker build .\n          echo skipped"))).toEqual([]);
  });

  test("a job on every PR builds the frontend, and the deploy waits for it", () => {
    expectGatesDeploy(stepsWhere((s) => workingDirOf(s) === "vaalikone-frontend" && /\bnpm run build\b/.test(runOf(s))));
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
    "a job on every PR builds %s as compose does, and the deploy waits for it",
    (_dockerfile, image) => {
      expectGatesDeploy(
        stepsWhere((s) =>
          dockerBuildsIn(s).some(
            (b) => b.context === image.context && b.dockerfile === image.dockerfile && b.target === image.target,
          ),
        ),
      );
    },
  );
});
