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

// ─── Middleware ───
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(morgan("short"));
app.use(express.json({ limit: "1mb" }));

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

// Admin routes
app.use("/api/admin/parties", partiesRouter);
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
