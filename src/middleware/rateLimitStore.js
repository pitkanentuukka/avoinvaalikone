const crypto = require("crypto");
const redis = require("../redis");

// Redis-backed express-rate-limit store, so limits are shared across backend
// replicas. It used to be rate-limit-redis, which loads its Lua scripts with
// SCRIPT LOAD when the store is constructed and only awaits the load on the
// first request: a load that failed first (Redis down at startup) was an
// unhandled rejection, and Node exited (issue #149). It also reloads the
// script and resends EVALSHA after *any* failure, so with a command timeout a
// slow EVALSHA that Redis still ran was counted twice. This store keeps no
// script state: it sends EVALSHA with a hash computed here and falls back to
// EVAL only when Redis answers NOSCRIPT (as node-redis's own scripts do).

// The limiters are in front of every API request and pass requests on store
// errors (passOnStoreError), so a Redis problem must cost a request at most
// this long; Redis runs next to the backend and normally answers in well
// under a millisecond. node-redis's own command timeout doesn't do this: it
// only covers a command still waiting to be written, and one already sent to
// a Redis that stopped answering waits for the reply indefinitely. A command
// that loses the race stays queued in node-redis until Redis answers or the
// connection drops, which commandsQueueMaxLength in src/redis.js bounds.
const COMMAND_TIMEOUT_MS = 500;

function sendCommand(args) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS} ms`)),
      COMMAND_TIMEOUT_MS
    );
  });
  return Promise.race([redis.sendCommand(args), timeout]).finally(() => clearTimeout(timer));
}

const script = (source) => ({ source, sha: crypto.createHash("sha1").update(source).digest("hex") });

// Fixed window: the first hit creates the counter with the window as its
// expiry, later hits only increment it. Returns { hits, ms until reset }.
const INCREMENT = script(`
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  redis.call("SET", KEYS[1], 1, "PX", ARGV[1])
  return { 1, tonumber(ARGV[1]) }
end
return { redis.call("INCR", KEYS[1]), ttl }
`);

// Plain DECR on a key that has expired would create a counter at -1 with no
// expiry.
const DECREMENT = script(`
if redis.call("PTTL", KEYS[1]) > 0 then
  redis.call("DECR", KEYS[1])
end
return 0
`);

async function runScript({ source, sha }, key, ...args) {
  const rest = ["1", key, ...args];
  try {
    return await sendCommand(["EVALSHA", sha, ...rest]);
  } catch (err) {
    // Redis forgets scripts on restart; EVAL runs the source and caches it
    // again. Nothing else is retried: after a timeout the EVALSHA may still
    // run, so retrying would count the hit twice, and wait on Redis again.
    if (!String(err?.message).startsWith("NOSCRIPT")) throw err;
    return sendCommand(["EVAL", source, ...rest]);
  }
}

class RedisStore {
  constructor(prefix) {
    // express-rate-limit reads prefix and localKeys to check that no request
    // is counted twice for the same key.
    this.prefix = prefix;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const [totalHits, ttl] = await runScript(INCREMENT, this.prefix + key, String(this.windowMs));
    return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + Number(ttl)) };
  }

  async decrement(key) {
    await runScript(DECREMENT, this.prefix + key);
  }

  async resetKey(key) {
    await sendCommand(["DEL", this.prefix + key]);
  }
}

// Returns undefined when REDIS_URL is unset, which makes express-rate-limit
// fall back to its per-process MemoryStore (dev).
module.exports = (prefix) => (redis ? new RedisStore(prefix) : undefined);
