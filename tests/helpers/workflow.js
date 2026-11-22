// .github/workflows/ci-cd.yml, parsed, for tests that check its settings.
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const WORKFLOW = path.join(__dirname, "../../.github/workflows/ci-cd.yml");

function workflow() {
  return yaml.load(fs.readFileSync(WORKFLOW, "utf8"));
}

// A job's step by its name.
function step(job, name) {
  const found = workflow().jobs[job].steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step "${name}" in job ${job} of ${WORKFLOW}`);
  return found;
}

module.exports = { workflow, step };
