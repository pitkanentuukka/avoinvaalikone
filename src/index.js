require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const partiesRouter = require("./routes/parties");
const { publicRouter: questionSetsPublicRouter, adminRouter: questionSetsAdminRouter } = require("./routes/questionSets");
const candidatesRouter = require("./routes/candidates");
const voterRouter = require("./routes/voter");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTPS Enforcement Middleware ───
// Trust proxy to handle HTTPS correctly in production
app.set('trust proxy', 1);

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
app.use(morgan("short"));
app.use(express.json({ limit: "1mb" }));

// ─── Rate Limiters ───

// Rate limiting for admin endpoints (strict)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
});

// Rate limiting for public submission endpoints
const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
});

// Rate limiting for voter match endpoint
const matchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
  skip: (req) => process.env.NODE_ENV !== 'production',
});

// ─── Routes ───

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Admin routes (with rate limiting)
app.use("/api/admin/parties", adminLimiter, partiesRouter);
app.use("/api/admin/question-sets", adminLimiter, questionSetsAdminRouter);

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
