// Child process for tests/unit/rateLimitWiring.test.js: starts the real app
// (src/index.js, with the environment the parent passes) and sends the
// requests it is given, reporting each status and duration over IPC.
//
// It runs in its own process so the app's own Redis client and stores, and
// any crash, stay out of the Jest worker.

const http = require("http");
const app = require("../../src/index");

const requests = JSON.parse(process.argv[2]);

function send(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const started = Date.now();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ method, path, status: res.statusCode, ms: Date.now() - started }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const results = [];
  for (const r of requests) results.push(await send(server.address().port, r));
  process.send({ results }, () => process.exit(0));
}

main().catch((err) => {
  process.send({ error: err.stack }, () => process.exit(1));
});
