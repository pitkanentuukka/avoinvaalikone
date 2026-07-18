// Optional Redis client, used as a shared store for rate limiting so limits
// are enforced across backend replicas. When REDIS_URL is unset (local dev
// without compose), callers fall back to per-process behavior.
const { createClient } = require("redis");

let client = null;

if (process.env.REDIS_URL) {
  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", (err) => console.error("Redis error:", err.message));
  client.connect().catch((err) => console.error("Redis connect failed:", err.message));
}

module.exports = client;
