require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { noStore } = require("./middleware/cacheControl");
const redisStore = require("./middleware/rateLimitStore");
const { pool } = require("./db/pool");
const partiesRouter = require("./routes/parties");
const { publicRouter: questionSetsPublicRouter, adminRouter: questionSetsAdminRouter } = require("./routes/questionSets");
const candidatesRouter = require("./routes/candidates");
const voterRouter = require("./routes/voter");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTPS Enforcement Middleware ───
// Trust proxy to handle HTTPS correctly in production.
// TRUST_PROXY_HOPS must equal the number of reverse proxies in front of the app
// (e.g. Cloudflare → Caddy → frontend nginx = 3). If it's lower than the real
// chain, req.ip resolves to a proxy's address instead of the client's, which
// collapses every rate-limit bucket into one shared per-proxy bucket.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));

// Redirect HTTP to HTTPS in production.
// Requires PUBLIC_HOST env var — falls back to skipping the redirect rather
// than trusting the user-supplied Host header (which would be an open redirect).
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    const host = process.env.PUBLIC_HOST;
    if (!host) {
      console.error('PUBLIC_HOST is not set — skipping HTTP→HTTPS redirect to avoid open redirect vulnerability');
      return next();
    }
    return res.redirect(301, `https://${host}${req.url}`);
  }
  next();
});

// ─── Middleware ───
app.use(helmet({
  hsts: {
    maxAge: 31536000, // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },
}));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
// In production only log failures: per-request logging at election-day rates
// is measurable event-loop and disk overhead with no diagnostic value.
app.use(morgan(":date[iso] :method :url :status :response-time ms - :res[content-length]", {
  skip: (req, res) => process.env.NODE_ENV === "production" && res.statusCode < 400,
}));
app.use(express.json({ limit: "1mb" }));

// ─── Rate Limiters ───

// Stores live in Redis when REDIS_URL is set, so the limits hold across
// backend replicas instead of multiplying by the replica count.

// Rate limiting for admin endpoints (strict)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
  store: redisStore("rl:admin:"),
});

// Rate limiting for public submission endpoints
const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
  store: redisStore("rl:submission:"),
});

// Rate limiting for voter match endpoint. The default allows for heavy carrier
// CGNAT (one IP can be hundreds of simultaneous voters on election night)
// while still capping a single abuser at ~5 req/s on the most expensive
// endpoint. RATE_LIMIT_MATCH_MAX is the election-night dial, and is also
// needed to run k6 load tests against a production-mode deployment.
const matchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MATCH_MAX || "300", 10),
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
  store: redisStore("rl:match:"),
});

// ─── Routes ───

// Health check. Deliberately no DB roundtrip (Docker/CI probe it frequently);
// the pool counters give free load visibility during the event.
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  });
});

// Admin routes (with rate limiting)
app.use("/api/admin/parties", adminLimiter, noStore, partiesRouter);
app.use("/api/admin/question-sets", adminLimiter, noStore, questionSetsAdminRouter);

// Public question-set routes (NGO submission rate limited)
app.post("/api/question-sets", submissionLimiter);
app.use("/api/question-sets", questionSetsPublicRouter);

// Candidate routes
//   Public:  GET /api/candidates, GET /api/candidates/:id
//   Party:   GET/POST/PUT under /api/candidates/party/:partyToken/...
app.use("/api/candidates", candidatesRouter);

// Voter routes
app.use("/api/voter", matchLimiter, voterRouter);

// ─── Error handling ───
app.use((req, res) => {
  res.status(404).json({ error: "Reittiä ei löytynyt" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Palvelinvirhe"
        : err.message || "Palvelinvirhe",
  });
});

// ─── Start ───
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🗳️  Vaalikone API running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`   CORS origin: ${process.env.CORS_ORIGIN || "http://localhost:5173"}\n`);
  });
}

module.exports = app;
