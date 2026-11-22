// Reads a block of .github/workflows/ci-cd.yml as text: the line that is
// exactly `header` (after indentation), e.g. "- name: Verify edge cache" or
// "deploy:", and every line under it, up to the next line indented no deeper.
const fs = require("fs");
const path = require("path");

const WORKFLOW = path.join(__dirname, "../../.github/workflows/ci-cd.yml");

function workflowBlock(header) {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) throw new Error(`no "${header}" in ${WORKFLOW}`);
  const indent = lines[start].search(/\S/);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() && l.search(/\S/) <= indent);
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

// A setting of the block itself, e.g. timeout-minutes: a key two columns
// deeper than the header, for a job ("deploy:") and a step ("- name: …")
// alike. Deeper lines (a step's, inside a job block) don't count.
function blockSetting(block, key) {
  const [first, ...rest] = block.split("\n");
  const indent = first.search(/\S/) + 2;
  const line = rest.find((l) => l.search(/\S/) === indent && l.trim().startsWith(`${key}:`));
  return line === undefined ? undefined : line.trim().slice(key.length + 1).trim();
}

module.exports = { workflowBlock, blockSetting };
