// #231: each backend process has its own SMTP pool (src/email.js), so
// production opens up to replicas × SMTP_MAX_CONNECTIONS connections. The docs
// described one shared pool, so an operator sizing it for a provider's limit
// would open three times as many connections as intended.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const prodReplicas = Number(read("docker-compose.prod.yml")
  .split(/^ {2}backend:$/m)[1]
  .match(/^\s+replicas:\s*(\d+)/m)[1]);

// The paragraphs (blank-line separated) that document SMTP_MAX_CONNECTIONS.
const passages = (file) => read(file).split(/\n\s*\n/).filter((p) => p.includes("SMTP_MAX_CONNECTIONS"));

const DOCS = [".env.example", "CLAUDE.md", "docs/production-readiness.md", "docker-compose.yml"];

test("production runs more than one backend replica", () => {
  expect(prodReplicas).toBeGreaterThan(1);
});

describe.each(DOCS)("%s on the SMTP pool size", (file) => {
  test("says the pool is per backend process, not shared", () => {
    const text = passages(file).join("\n\n");
    expect(text).not.toBe("");
    expect(text).toMatch(/per (backend )?(process|replica)/i);
    expect(text).not.toMatch(/shared pool/i);
  });

  test("any replica count it gives matches docker-compose.prod.yml", () => {
    const counts = passages(file).join("\n\n").match(/\b\d+(?= (backend )?replicas)/g) ?? [];
    for (const n of counts) expect(Number(n)).toBe(prodReplicas);
  });
});
