const crypto = require("crypto");
const redis = require("../redis");
const { createOutageLog } = require("../outageLog");

// Redis-backed express-rate-limit store, so limits are shared across backend
// replicas. It used to be rate-limit-redis, which loads its Lua scripts with
// SCRIPT LOAD when the store is constructed and only awaits the load on the
// first request: a load that failed first (Redis down at startup) was an
// unhandled rejection, and Node exited (issue #149). It also reloaded the
// script and resent EVALSHA after *any* failure, so with a timeout a slow
// EVALSHA that Redis still ran was counted twice. This store keeps no
// script state: it sends EVALSHA with a hash computed here and falls back to
// EVAL only when Redis answers NOSCRIPT (as node-redis's own scripts do).

// The limiters are in front of every API request and pass requests on store
// errors (failOpenLimiter), so a Redis problem may cost a request at most
// this long. node-redis's own command timeout doesn't bound it: it only
// covers a command still waiting to be written, and one already sent to a
// Redis that stopped answering waits for the reply indefinitely.
//
// Redis normally answers in well under a millisecond, but the clock also runs
// while the event loop is busy: node-redis writes the command and reads the
// reply in later loop iterations. A short deadline would fail limiting open on
// a replica lagging under a flood, the moment it matters most. With a hung
// Redis under load the cost stays small anyway: commands that miss the
// deadline wait in node-redis until Redis answers or the connection drops,
// and once commandsQueueMaxLength (src/redis.js) of them do, new ones fail at
// once.
const STORE_TIMEOUT_MS = 2000;

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis rate-limit store timed out after ${STORE_TIMEOUT_MS} ms`)),
      STORE_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    return await redis.sendCommand(["EVALSHA", sha, ...rest]);
  } catch (err) {
    // Redis forgets scripts on restart; EVAL runs the source and caches it
    // again. Nothing else is retried: an EVALSHA that failed some other way
    // may still have run, and a retry would count the hit twice.
    if (!String(err?.message).startsWith("NOSCRIPT")) throw err;
    return redis.sendCommand(["EVAL", source, ...rest]);
  }
}

// One log for every limiter's store: they share one Redis, so an outage is
// one outage (issue #156).
const outageLog = createOutageLog("Rate-limit store");

// What the store throws when Redis fails. src/middleware/rateLimiter.js lets
// the request through on it, without the per-request stack trace
// express-rate-limit's passOnStoreError logs; the outage log has the message.
class StoreError extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause), { cause });
    this.name = "StoreError";
  }
}

// Runs one store operation against Redis. Every way it can fail, including a
// reply it can't use (parse throws), becomes a StoreError, so the limiter
// fails open rather than 500ing. Whichever operation fails first, the line
// says what failing means for requests.
async function call(operation, what, parse = (reply) => reply) {
  try {
    const result = parse(await withTimeout(operation()));
    outageLog.recovered();
    return result;
  } catch (err) {
    outageLog.failure(`${what} failed (${err?.message ?? err}); letting requests through without rate limiting`);
    throw new StoreError(err);
  }
}

// The INCREMENT script always answers [hits >= 1, ttl > 0]; anything else is
// a reply the store can't trust (a misbehaving Redis-compatible proxy).
function parseIncrement(reply) {
  const [totalHits, ttl] = Array.isArray(reply) && reply.length === 2 && reply.every((v) => typeof v === "number")
    ? reply
    : [];
  if (!(Number.isInteger(totalHits) && totalHits >= 1 && ttl > 0)) {
    throw new Error(`unexpected reply ${String(reply).slice(0, 100)}`);
  }
  return { totalHits, resetTime: new Date(Date.now() + ttl) };
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
    return call(() => runScript(INCREMENT, this.prefix + key, String(this.windowMs)), "increment", parseIncrement);
  }

  // express-rate-limit awaits this inside response "finish"/"close"/"error"
  // handlers that catch nothing (skipFailedRequests, skipSuccessfulRequests),
  // so a rejection here would exit Node; failing open doesn't cover it.
  // Missing one uncount only leaves a hit counted.
  async decrement(key) {
    try {
      await call(() => runScript(DECREMENT, this.prefix + key), "decrement");
    } catch {
      // Logged by call().
    }
  }

  async resetKey(key) {
    await call(() => redis.sendCommand(["DEL", this.prefix + key]), "reset");
  }
}

// Returns undefined when REDIS_URL is unset, which makes express-rate-limit
// fall back to its per-process MemoryStore (dev).
module.exports = (prefix) => (redis ? new RedisStore(prefix) : undefined);
module.exports.StoreError = StoreError;
module.exports.outageLog = outageLog;
