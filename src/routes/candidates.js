const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db/pool");
const { requirePartyToken, requireCandidateToken, requireRegistrationToken } = require("../middleware/auth");
const { isValidLength, isValidUrl, isValidEmail, validateUUIDParam, isValidUUID } = require("../middleware/validation");
const { publicCache, noStore } = require("../middleware/cacheControl");
const microCache = require("../middleware/microCache");
const redisStore = require("../middleware/rateLimitStore");
const { sendCandidateLinkEmail } = require("../email");

const router = Router();

// Party, candidate and registration tokens are bearer credentials. Rate-limit
// the token-gated routes so the token space cannot be brute-forced (public
// candidate reads below stay unthrottled).
function tokenLimiter(prefix, max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max,
    message: { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
    skip: (req) => process.env.NODE_ENV !== "production",
    store: redisStore(prefix),
    // Fail open on Redis errors: tokens are high-entropy, so a transient outage
    // dropping the brute-force cap is a lesser evil than 500ing candidate edits.
    passOnStoreError: true,
  });
}

router.use("/party", tokenLimiter("rl:party:", 60), noStore);
// Higher caps for candidates: a campaign event can put dozens of candidates
// behind one office IP, each loading, registering and saving several times.
router.use("/register", tokenLimiter("rl:register:", 100), noStore);
router.use("/me", tokenLimiter("rl:me:", 300), noStore);

const frontendBaseUrl = () => process.env.CORS_ORIGIN || "http://localhost:5173";

// Postgres CHECK violation — candidates_constituency_valid rejects anything
// outside the 13 parliamentary constituencies.
const CHECK_VIOLATION = "23514";

/**
 * Validate the candidate profile fields shared by self-registration and
 * profile updates. Returns a Finnish error message, or null if valid.
 */
function profileError({ name, photoUrl, bio, email, constituency }) {
  if (typeof name !== "string" || !name.trim()) {
    return "Ehdokkaan nimi vaaditaan";
  }
  if (!isValidLength(name, 255)) {
    return "Ehdokkaan nimi on liian pitkä (maksimi: 255 merkkiä)";
  }
  if (typeof constituency !== "string" || !constituency.trim()) {
    return "Vaalipiiri vaaditaan";
  }
  if (!isValidLength(constituency, 255)) {
    return "Vaalipiiri on liian pitkä (maksimi: 255 merkkiä)";
  }
  // Required: it is how a candidate gets their personal link back if they lose it.
  if (typeof email !== "string" || !email.trim()) {
    return "Sähköpostiosoite vaaditaan";
  }
  if (!isValidLength(email, 255)) {
    return "Sähköpostiosoite on liian pitkä (maksimi: 255 merkkiä)";
  }
  if (!isValidEmail(email.trim())) {
    return "Sähköpostiosoite on virheellinen";
  }
  if (photoUrl != null && photoUrl !== "") {
    if (!isValidLength(photoUrl, 500)) {
      return "Kuvan URL on liian pitkä (maksimi: 500 merkkiä)";
    }
    if (!isValidUrl(photoUrl)) {
      return "Kuvan URL on virheellinen (vaaditaan http:// tai https://)";
    }
  }
  if (bio != null && bio !== "" && !isValidLength(bio, 1000)) {
    return "Biografia on liian pitkä (maksimi: 1000 merkkiä)";
  }
  return null;
}

/** Shape candidate_answers rows into the { [questionId]: {...} } dict the UI uses. */
function answersDict(rows) {
  return rows.reduce((acc, a) => {
    acc[a.question_id] = {
      value: a.value,
      explanation: a.explanation,
      answeredAt: a.answered_at,
    };
    return acc;
  }, {});
}

// ─── Public ───

// GET /api/candidates — list all candidates with party info
router.get("/", publicCache(300), microCache(), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.bio, c.constituency, c.created_at,
              p.id AS party_id, p.name AS party_name
       FROM candidates c
       JOIN parties p ON p.id = c.party_id
       ORDER BY p.name, c.name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/candidates/:id — single candidate with all answers
router.get("/:id", validateUUIDParam("id"), publicCache(300), microCache(), async (req, res, next) => {
  try {
    const { rows: cRows } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.bio, c.constituency, c.created_at,
              p.id AS party_id, p.name AS party_name
       FROM candidates c
       JOIN parties p ON p.id = c.party_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (cRows.length === 0) {
      return res.status(404).json({ error: "Ehdokasta ei löytynyt" });
    }

    const { rows: answers } = await db.query(
      `SELECT ca.question_id, ca.value, ca.explanation, ca.answered_at
       FROM candidate_answers ca
       WHERE ca.candidate_id = $1`,
      [req.params.id]
    );

    res.json({ ...cRows[0], answers: answersDict(answers) });
  } catch (err) {
    next(err);
  }
});

// ─── Party-token gated (secretary's management access) ───
// The party can see its candidates, re-send their links, remove sign-ups and
// rotate the registration link — but never sees candidate tokens, so it cannot
// change a candidate's profile or answers.

// GET /api/candidates/party/:partyToken — party overview
router.get("/party/:partyToken", requirePartyToken, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.email, c.constituency, c.created_at,
              (SELECT COUNT(*) FROM candidate_answers ca WHERE ca.candidate_id = c.id) AS answer_count
       FROM candidates c
       WHERE c.party_id = $1
       ORDER BY c.name`,
      [req.party.id]
    );
    res.json({
      party: { id: req.party.id, name: req.party.name, registrationToken: req.party.registration_token },
      candidates: rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/party/:partyToken/registration-token — rotate the
// registration link (e.g. it leaked). Existing candidates are unaffected.
router.post("/party/:partyToken/registration-token", requirePartyToken, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "UPDATE parties SET registration_token = DEFAULT WHERE id = $1 RETURNING registration_token",
      [req.party.id]
    );
    res.json({ registrationToken: rows[0].registration_token });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/party/:partyToken/candidates/:id/send-link — email the
// candidate their personal link. Only ever goes to the candidate's own address.
router.post(
  "/party/:partyToken/candidates/:id/send-link",
  requirePartyToken,
  validateUUIDParam("id"),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        "SELECT id, name, email, token FROM candidates WHERE id = $1 AND party_id = $2",
        [req.params.id, req.party.id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Ehdokasta ei löytynyt tässä puolueessa" });
      }
      if (!rows[0].email) {
        return res.status(409).json({ error: "Ehdokkaalla ei ole sähköpostiosoitetta" });
      }
      try {
        await sendCandidateLinkEmail(rows[0], req.party.name, frontendBaseUrl());
      } catch (mailErr) {
        console.error("Ehdokaslinkin lähetys epäonnistui:", mailErr);
        return res.status(502).json({ error: "Sähköpostin lähetys epäonnistui" });
      }
      res.json({ sent: true });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/candidates/party/:partyToken/candidates/:id — remove a candidate
// (e.g. a sign-up that isn't really the party's candidate).
router.delete(
  "/party/:partyToken/candidates/:id",
  requirePartyToken,
  validateUUIDParam("id"),
  async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        "DELETE FROM candidates WHERE id = $1 AND party_id = $2",
        [req.params.id, req.party.id]
      );
      if (rowCount === 0) {
        return res.status(404).json({ error: "Ehdokasta ei löytynyt tässä puolueessa" });
      }
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Registration-link gated (candidate self-registration) ───

// GET /api/candidates/register/:registrationToken — which party this link is for
router.get("/register/:registrationToken", requireRegistrationToken, (req, res) => {
  res.json({ party: { name: req.party.name } });
});

// POST /api/candidates/register/:registrationToken — candidate signs up.
// Returns the candidate's personal token; they are visible to voters at once.
router.post("/register/:registrationToken", requireRegistrationToken, async (req, res, next) => {
  try {
    const error = profileError(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    const { name, photoUrl, bio, email, constituency } = req.body;

    // Signing up again with the same name and address is almost always a
    // candidate who lost their link. Don't create a duplicate visible to
    // voters — send the existing link to that (already registered) address
    // instead. Matching on name too lets a party office register several
    // candidates under one shared address.
    const { rows: existing } = await db.query(
      `SELECT id, name, email, token FROM candidates
       WHERE party_id = $1 AND lower(email) = lower($2) AND lower(name) = lower($3)`,
      [req.party.id, email.trim(), name.trim()]
    );
    if (existing.length > 0) {
      let sent = false;
      try {
        await sendCandidateLinkEmail(existing[0], req.party.name, frontendBaseUrl());
        sent = true;
      } catch (mailErr) {
        console.error("Ehdokaslinkin lähetys epäonnistui:", mailErr);
      }
      return res.status(409).json({
        error: sent
          ? "Olet jo rekisteröitynyt näillä tiedoilla. Lähetimme henkilökohtaisen linkkisi sähköpostiisi."
          : "Olet jo rekisteröitynyt näillä tiedoilla. Pyydä puolueesi yhteyshenkilöä lähettämään linkkisi uudelleen.",
      });
    }

    const { rows } = await db.query(
      `INSERT INTO candidates (party_id, name, photo_url, bio, email, constituency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, photo_url, bio, email, constituency, token, created_at`,
      [req.party.id, name.trim(), photoUrl?.trim() || null, bio?.trim() || null, email.trim(), constituency.trim()]
    );
    const candidate = rows[0];
    res.status(201).json(candidate);

    // The link is also shown on screen, so a failed email isn't fatal.
    if (process.env.SMTP_HOST) {
      sendCandidateLinkEmail(candidate, req.party.name, frontendBaseUrl()).catch((err) =>
        console.error("Ehdokaslinkin lähetys epäonnistui:", err)
      );
    }
  } catch (err) {
    if (err.code === CHECK_VIOLATION) {
      return res.status(400).json({ error: "Virheellinen vaalipiiri" });
    }
    next(err);
  }
});

// ─── Candidate-token gated (the candidate's personal link) ───

// GET /api/candidates/me/:candidateToken — own profile and answers
router.get("/me/:candidateToken", requireCandidateToken, async (req, res, next) => {
  try {
    const { rows: [candidate] } = await db.query(
      "SELECT id, name, photo_url, bio, email, constituency FROM candidates WHERE id = $1",
      [req.candidate.id]
    );
    const { rows: answers } = await db.query(
      `SELECT question_id, value, explanation, answered_at
       FROM candidate_answers WHERE candidate_id = $1`,
      [req.candidate.id]
    );
    res.json({
      ...candidate,
      party: { id: req.candidate.party_id, name: req.candidate.party_name },
      answers: answersDict(answers),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/candidates/me/:candidateToken — update own profile (full replace)
router.put("/me/:candidateToken", requireCandidateToken, async (req, res, next) => {
  try {
    const error = profileError(req.body);
    if (error) {
      return res.status(400).json({ error });
    }
    const { name, photoUrl, bio, email, constituency } = req.body;

    const { rows } = await db.query(
      `UPDATE candidates
       SET name = $1, photo_url = $2, bio = $3, email = $4, constituency = $5, updated_at = now()
       WHERE id = $6
       RETURNING id, name, photo_url, bio, email, constituency, updated_at`,
      [name.trim(), photoUrl?.trim() || null, bio?.trim() || null, email.trim(), constituency.trim(), req.candidate.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === CHECK_VIOLATION) {
      return res.status(400).json({ error: "Virheellinen vaalipiiri" });
    }
    next(err);
  }
});

// PUT /api/candidates/me/:candidateToken/answers — save own answers (upsert)
router.put("/me/:candidateToken/answers", requireCandidateToken, async (req, res, next) => {
  const { answers } = req.body;
  // answers: { [questionId]: { value: 0-4, explanation?: string } }
  if (!answers || typeof answers !== "object") {
    return res.status(400).json({ error: "Vastaukset vaaditaan" });
  }

  const client = await db.getClient();
  try {
    // Skip questions that no longer exist (merged or deleted while the
    // candidate had the form open) instead of failing the whole save on a
    // foreign-key violation.
    const ids = Object.keys(answers).filter(isValidUUID);
    const { rows: existingRows } = ids.length
      ? await client.query("SELECT id FROM questions WHERE id = ANY($1)", [ids])
      : { rows: [] };
    const existingIds = new Set(existingRows.map((r) => r.id));

    await client.query("BEGIN");

    let count = 0;
    for (const [questionId, answer] of Object.entries(answers)) {
      if (!existingIds.has(questionId) || !answer || typeof answer !== "object") continue;

      const value = parseInt(answer.value, 10);
      if (isNaN(value) || value < 0 || value > 4) continue;

      // Validate explanation length if provided
      if (answer.explanation && !isValidLength(answer.explanation, 500)) {
        continue;
      }

      await client.query(
        `INSERT INTO candidate_answers (candidate_id, question_id, value, explanation)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (candidate_id, question_id)
         DO UPDATE SET value = $3, explanation = $4, answered_at = now()`,
        [req.candidate.id, questionId, value, answer.explanation?.trim() || ""]
      );
      count++;
    }

    await client.query(
      "UPDATE candidates SET updated_at = now() WHERE id = $1",
      [req.candidate.id]
    );

    await client.query("COMMIT");
    res.json({ saved: count });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
