// Minimal RESP server for tests/unit/redisRateLimitStore.test.js. It answers
// just what node-redis and src/middleware/rateLimitStore.js send (HELLO,
// CLIENT SETINFO, EVALSHA, EVAL, DEL), so the tests can take Redis down,
// bring it back, pause it or make it refuse commands, without a real Redis.
//
// mode:
//   "ok"      — behaves like Redis. Scripts are kept per instance, so a new
//               instance (a restarted Redis) answers NOSCRIPT until EVAL.
//   "loading" — connects, then answers every command with -LOADING, as Redis
//               does while it loads its dataset after a restart.
//   "hang"    — connects, then holds every command without answering, like a
//               paused Redis. Setting another mode answers the held commands
//               in order, as a resumed Redis would.
//   "odd"     — connects, then answers every command +OK: a reply the store
//               can't use (a Redis-compatible proxy misbehaving).

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

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

class FakeRedis {
  #mode;

  constructor(mode = "ok") {
    this.#mode = mode;
    this.held = [];
    this.scripts = new Map();
    this.hits = new Map();
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.#onConnection(socket));
  }

  get mode() {
    return this.#mode;
  }

  set mode(mode) {
    this.#mode = mode;
    if (mode === "hang") return;
    const held = this.held;
    this.held = [];
    for (const { socket, args } of held) this.#handle(socket, args);
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
      for (const args of parsed.commands) this.#handle(socket, args);
    });
  }

  #handle(socket, args) {
    const command = args[0].toUpperCase();
    // The handshake goes through in every mode, so the client is connected.
    if (command === "HELLO") return socket.write("%1\r\n+proto\r\n:3\r\n");
    if (command === "CLIENT") return socket.write("+OK\r\n");
    if (this.#mode === "hang") return this.held.push({ socket, args });
    if (this.#mode === "loading") return socket.write("-LOADING Redis is loading the dataset in memory\r\n");
    if (this.#mode === "odd") return socket.write("+OK\r\n");
    if (!socket.destroyed) socket.write(this.#reply(command, args.slice(1)));
  }

  #reply(command, args) {
    if (command === "EVAL") {
      this.scripts.set(sha1(args[0]), args[0]);
      return this.#run(args[0], args[2]);
    }
    if (command === "EVALSHA") {
      const source = this.scripts.get(args[0]);
      if (!source) return "-NOSCRIPT No matching script. Please use EVAL.\r\n";
      return this.#run(source, args[2]);
    }
    if (command === "DEL") {
      const existed = this.hits.delete(args[0]);
      return `:${existed ? 1 : 0}\r\n`;
    }
    return "+OK\r\n";
  }

  // Not a Lua interpreter: tells the store's scripts apart by what they call.
  #run(source, key) {
    if (source.includes('"INCR"')) {
      const hits = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, hits);
      return `*2\r\n:${hits}\r\n:60000\r\n`;
    }
    if (source.includes('"DECR"')) {
      if (this.hits.has(key)) this.hits.set(key, this.hits.get(key) - 1);
      return ":0\r\n";
    }
    return "-ERR unknown script\r\n";
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
