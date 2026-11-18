const { createOutageLog } = require("./outageLog");

// src/redis.js logs connection errors through this: node-redis emits one for
// each reconnect attempt, ~2 s apart while Redis is down, and logging each
// one was bounded but noisy (issue #156). A module of its own so tests can
// see its state.
module.exports = createOutageLog("Redis connection");
