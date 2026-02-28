require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const partiesRouter = require("./routes/parties");
const questionSetsRouter = require("./routes/questionSets");
const candidatesRouter = require("./routes/candidates");
const voterRouter = require("./routes/voter");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTPS Enforcement Middleware ───
// Trust proxy to handle HTTPS correctly in production
app.set('trust proxy', 1);

// Redirect HTTP to HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.header('host')}${req.url}`);
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
});

// Rate limiting for voter match endpoint
const matchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
});

// ─── Routes ───

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Admin routes (with rate limiting)
app.use("/api/admin/parties", adminLimiter, partiesRouter);
app.use("/api/admin/question-sets", adminLimiter, questionSetsRouter);
app.use("/api/question-sets", questionSetsRouter);

// NGO submission (rate limited)
app.post("/api/question-sets", submissionLimiter);

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
app.listen(PORT, () => {
  console.log(`\n🗳️  Vaalikone API running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   CORS origin: ${process.env.CORS_ORIGIN || "http://localhost:5173"}\n`);
});

module.exports = app;
