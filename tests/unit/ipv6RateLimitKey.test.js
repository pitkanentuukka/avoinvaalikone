const { fork } = require("child_process");
const crypto = require("crypto");
const path = require("path");

// One IPv6 host has a whole subnet of source addresses: an ordinary /64, and
// usually a /56 or /48 delegated to the customer. Each limiter must count the
// host's subnet as one client, or rotating addresses gets past every limit
// and fills Redis with a key per address (issue #182). IPv4 clients stay one
// key per address, and an IPv4 address in IPv4-mapped IPv6 form is the same
// client as the plain address.
//
// The real app runs in a child process (tests/helpers/appRequestsChild.js),
// in production mode (the only mode the limiters run in), without Redis, so
// the limiters use express-rate-limit's in-process MemoryStore: the key is
// chosen before the store, so this tests the same keys Redis would get.

jest.setTimeout(30000);

const CHILD = path.join(__dirname, "../helpers/appRequestsChild.js");
// A NUL is rejected (404) before the token is looked up in the database.
const BAD_TOKEN = "%00";
const uuid = () => crypto.randomUUID();

// Every limiter the app mounts, with its limit in this test's environment
// (the env-configurable ones are set low below). `request()` gives a request
// the limiter counts; the database is unreachable, so the public reads fail
// (and the list limiter counts only failures).
const LIMITERS = [
  { name: "admin", max: 30, request: () => ({ method: "GET", path: "/api/admin/parties" }) },
  { name: "party", max: 60, request: () => ({ method: "GET", path: `/api/candidates/party/${BAD_TOKEN}` }) },
  { name: "register", max: 100, request: () => ({ method: "GET", path: `/api/candidates/register/${BAD_TOKEN}` }) },
  { name: "me", max: 300, request: () => ({ method: "GET", path: `/api/candidates/me/${BAD_TOKEN}` }) },
  { name: "submission", max: 20, request: () => ({ method: "POST", path: "/api/question-sets", body: {} }) },
  { name: "match", max: 5, request: () => ({ method: "POST", path: "/api/voter/match", body: {} }) },
  { name: "candidate read", max: 5, request: () => ({ method: "GET", path: `/api/candidates/${uuid()}` }) },
  { name: "list read", max: 5, request: () => ({ method: "GET", path: "/api/question-sets" }) },
];

const hex = (n, width) => n.toString(16).padStart(width, "0");
// The i-th address in one host's 2001:db8:1:ab00::/56: a different /64 and
// interface id each time.
const rotated = (i) => `2001:db8:1:ab${hex(i % 256, 2)}::${hex(i + 1, 1)}`;
const from = (ip, request) => ({ ...request, headers: { "X-Forwarded-For": ip } });

// For each limiter: max requests from rotating addresses of one /56, one more
// from yet another address of it (which must be limited), then one from
// another /56 and one from an unrelated IPv4 address (which must not be).
// Last, max requests from a single IPv4 address in mapped form, then one from
// the plain address, which must be limited too.
const plan = [];
for (const limiter of LIMITERS) {
  for (let i = 0; i < limiter.max; i++) plan.push({ limiter: limiter.name, kind: "fill", ...from(rotated(i), limiter.request()) });
  plan.push({ limiter: limiter.name, kind: "same /56", ...from(rotated(limiter.max), limiter.request()) });
  plan.push({ limiter: limiter.name, kind: "other /56", ...from("2001:db8:1:ac00::1", limiter.request()) });
  plan.push({ limiter: limiter.name, kind: "other IPv4", ...from("198.51.100.1", limiter.request()) });
  for (let i = 0; i < limiter.max; i++) plan.push({ limiter: limiter.name, kind: "fill", ...from("::ffff:203.0.113.9", limiter.request()) });
  plan.push({ limiter: limiter.name, kind: "plain IPv4", ...from("203.0.113.9", limiter.request()) });
}

let results;

beforeAll(async () => {
  let output = "";
  const env = {
    ...process.env,
    NODE_ENV: "production",
    TRUST_PROXY_HOPS: "1",
    RATE_LIMIT_MATCH_MAX: "5",
    RATE_LIMIT_CANDIDATE_READ_MAX: "5",
    RATE_LIMIT_LIST_READ_MAX: "5",
    // Nothing listens on port 1: the public reads fail, nothing else needs it.
    DATABASE_URL: "postgresql://vaalikone@127.0.0.1:1/vaalikone",
    ADMIN_SECRET: "test-admin-secret",
  };
  // Empty, not deleted: tests/setupEnv.js sets it empty so that dotenv can't
  // load a developer's REDIS_URL from .env into the app.
  env.REDIS_URL = "";
  // Too many requests for one argument: they go over IPC instead.
  const child = fork(CHILD, [], { execArgv: [], silent: true, env });
  child.send(plan);
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const message = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`app exited (${code}) before answering:\n${output}`)));
  });
  if (message.error) throw new Error(`${message.error}\n${output}`);
  // The child reports results in the order sent.
  results = message.results.map((r, i) => ({ ...plan[i], status: r.status }));
});

const statusOf = (limiter, kind) => results.find((r) => r.limiter === limiter && r.kind === kind).status;

describe.each(LIMITERS.map((l) => [l.name]))("the %s limiter", (name) => {
  test("never limits the requests within its budget", () => {
    const filled = results.filter((r) => r.limiter === name && r.kind === "fill");
    expect(filled.filter((r) => r.status === 429)).toEqual([]);
  });

  test("counts every address of one IPv6 /56 as one client", () => {
    expect(statusOf(name, "same /56")).toBe(429);
  });

  test("keeps another /56 and another IPv4 address apart", () => {
    expect(statusOf(name, "other /56")).not.toBe(429);
    expect(statusOf(name, "other IPv4")).not.toBe(429);
  });

  test("counts an IPv4-mapped address as the plain IPv4 address", () => {
    expect(statusOf(name, "plain IPv4")).toBe(429);
  });
});
