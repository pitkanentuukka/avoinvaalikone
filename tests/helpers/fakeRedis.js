// Minimal RESP server for tests/unit/redisRateLimitStore.test.js. It answers
// just what node-redis and rate-limit-redis send (HELLO, CLIENT SETINFO,
// SCRIPT LOAD, EVALSHA), so the tests can take Redis down, bring it back,
// hang it or make it refuse commands, without a real Redis server.
//
// mode:
//   "ok"      — behaves like Redis. Scripts are kept per instance, so a new
//               instance (a restarted Redis) answers NOSCRIPT until reloaded.
//   "loading" — connects, then answers every command with -LOADING, as Redis
//               does while it loads its dataset after a restart.
//   "hang"    — connects, then never answers a command.

const net = require("net");
const crypto = require("crypto");

// Splits complete RESP arrays of bulk strings off the front of buffer.
function parseCommands(buffer) {
  const commands = [];
  let offset = 0;
  outer: while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n", offset);
    if (headerEnd === -1) break;
    const count = Number(buffer.toString("utf8", offset + 1, headerEnd));
    let pos = headerEnd + 2;
    const args = [];
    for (let i = 0; i < count; i++) {
      const lenEnd = buffer.indexOf("\r\n", pos);
      if (lenEnd === -1) break outer;
      const len = Number(buffer.toString("utf8", pos + 1, lenEnd));
      const start = lenEnd + 2;
      if (buffer.length < start + len + 2) break outer;
      args.push(buffer.toString("utf8", start, start + len));
      pos = start + len + 2;
    }
    commands.push(args);
    offset = pos;
  }
  return { commands, rest: buffer.subarray(offset) };
}

const bulk = (s) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;

class FakeRedis {
  constructor(mode = "ok") {
    this.mode = mode;
    this.scripts = new Set();
    this.hits = new Map();
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.#onConnection(socket));
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve(this.server.address().port));
    });
  }

  // Like Redis going away: the port stops accepting and open connections drop.
  stop() {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  #onConnection(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const parsed = parseCommands(Buffer.concat([buffer, chunk]));
      buffer = parsed.rest;
      for (const args of parsed.commands) {
        const reply = this.#reply(args);
        if (reply !== null) socket.write(reply);
      }
    });
  }

  #reply([name, ...args]) {
    const command = name.toUpperCase();
    if (command === "HELLO") return "%1\r\n+proto\r\n:3\r\n";
    if (command === "CLIENT") return "+OK\r\n";
    if (this.mode === "hang") return null;
    if (this.mode === "loading") return "-LOADING Redis is loading the dataset in memory\r\n";
    if (command === "SCRIPT" && args[0].toUpperCase() === "LOAD") {
      const sha = crypto.createHash("sha1").update(args[1]).digest("hex");
      this.scripts.add(sha);
      return bulk(sha);
    }
    if (command === "EVALSHA") {
      if (!this.scripts.has(args[0])) return "-NOSCRIPT No matching script. Please use EVAL.\r\n";
      const key = args[2];
      const hits = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, hits);
      return `*2\r\n:${hits}\r\n:60000\r\n`;
    }
    return "+OK\r\n";
  }
}

// A loopback port nothing listens on, for "Redis is down at startup".
async function unusedPort() {
  const probe = new FakeRedis();
  const port = await probe.listen(0);
  await probe.stop();
  return port;
}

module.exports = { FakeRedis, unusedPort };
