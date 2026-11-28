// #231: each backend process has its own SMTP pool (src/email.js), so
// production opens up to replicas × SMTP_MAX_CONNECTIONS connections. The docs
// described one shared pool, so an operator sizing it for a provider's limit
// would open three times as many connections as intended.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// The backend service's block only, up to the next top-level service.
function prodBackendReplicas() {
  const backend = read("docker-compose.prod.yml").split(/^ {2}backend:.*$/m)[1]?.split(/^ {2}\S/m)[0];
  const n = backend?.match(/^\s+replicas:\s*(\d+)/m)?.[1];
  if (!n) throw new Error("docker-compose.prod.yml: no deploy.replicas in the backend service");
  return Number(n);
}
const prodReplicas = prodBackendReplicas();

// The paragraphs and list items that document SMTP_MAX_CONNECTIONS, with line
// breaks and comment markers collapsed so wrapping doesn't matter.
const passages = (file) => read(file).split(/\n\s*\n|\n(?=\s*- )/)
  .filter((p) => p.includes("SMTP_MAX_CONNECTIONS"))
  .map((p) => p.replace(/\n\s*#?\s*/g, " "));

const DOCS = [".env.example", "CLAUDE.md", "docs/production-readiness.md", "docker-compose.yml"];

test("production runs more than one backend replica", () => {
  expect(prodReplicas).toBeGreaterThan(1);
});

describe.each(DOCS)("%s on the SMTP pool size", (file) => {
  test("says the pool is per backend process, not shared", () => {
    const text = passages(file).join("\n\n");
    expect(text).not.toBe("");
    expect(text).toMatch(/per (backend )?(process|replica)/i);
    expect(text).not.toMatch(/\b(the|one|a) shared pool/i);
  });

  test("any replica count or divisor it gives matches docker-compose.prod.yml", () => {
    const text = passages(file).join("\n\n");
    const counts = [
      ...text.matchAll(/\b(\d+)(?= (backend )?replicas)/g),
      ...text.matchAll(/\bdivided by (\d+)/g),
    ].map((m) => Number(m[1]));
    for (const n of counts) expect(n).toBe(prodReplicas);
  });
});
