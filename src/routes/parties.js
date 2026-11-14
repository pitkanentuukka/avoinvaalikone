const { Router } = require("express");
const crypto = require("crypto");
const db = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { isValidLength, isValidEmail, validateUUIDParam } = require("../middleware/validation");
const { sendCandidateLinkEmail } = require("../email");

const router = Router();

// Generate a URL-safe party token. The slug is only a human-readable prefix;
// the security comes from 24 random bytes (192 bits) of CSPRNG entropy, since
// the token is a bearer credential for the party portal. Migration 012 builds
// the same format in SQL.
function newPartyToken(name) {
  const slug = name
    .toLowerCase()
    .replace(/[äå]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 12);
  return `${slug}-${crypto.randomBytes(24).toString("base64url")}`;
}

// GET /api/admin/parties — list all parties
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT id, name, token, registration_token, email, created_at FROM parties ORDER BY created_at"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/parties — create a new party
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Puolueen nimi vaaditaan" });
    }
    
    // Validate field lengths
    if (!isValidLength(name, 100)) {
      return res.status(400).json({ error: "Puolueen nimi on liian pitkä (maksimi: 100 merkkiä)" });
    }
    // Optional: null, undefined and "" mean "no email"; anything else must be
    // a string (a falsy non-string like 0 or false would crash .trim()).
    const hasEmail = email != null && email !== "";
    if (hasEmail && typeof email !== "string") {
      return res.status(400).json({ error: "Virheellinen sähköpostiosoite" });
    }
    if (hasEmail && !isValidLength(email, 255)) {
      return res.status(400).json({ error: "Sähköpostiosoite on liian pitkä (maksimi: 255 merkkiä)" });
    }
    if (hasEmail && !isValidEmail(email)) {
      return res.status(400).json({ error: "Virheellinen sähköpostiosoite" });
    }

    const token = newPartyToken(name);

    const { rows } = await db.query(
      `INSERT INTO parties (name, token, email)
       VALUES ($1, $2, $3)
       RETURNING id, name, token, registration_token, email, created_at`,
      [name.trim(), token, hasEmail ? email.trim() : null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Puolue on jo olemassa" });
    }
    next(err);
  }
});

// POST /api/admin/parties/:id/token — rotate the party token (e.g. it leaked).
// The old party portal link stops working; candidates' links are unaffected.
router.post("/:id/token", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows: existing } = await db.query("SELECT name FROM parties WHERE id = $1", [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Puoluetta ei löytynyt" });
    }
    const { rows } = await db.query(
      `UPDATE parties SET token = $1 WHERE id = $2
       RETURNING id, name, token, registration_token, email, created_at`,
      [newPartyToken(existing[0].name), req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/parties/:id/candidates — the party's candidates with their
// personal tokens. Unlike the party portal, admin sees the tokens, so it can
// hand a link over by hand to a candidate who has no email address on file.
// last_email_* is the latest email_log row for the candidate, so the admin can
// see whose link actually went out.
router.get("/:id/candidates", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.email, c.constituency, c.token,
              (SELECT COUNT(*) FROM candidate_answers ca
               WHERE ca.candidate_id = c.id
                 AND EXISTS (
                   SELECT 1 FROM question_set_questions qsq
                   JOIN question_sets qs ON qs.id = qsq.question_set_id
                   WHERE qsq.question_id = ca.question_id
                     AND qs.status = 'approved' AND qs.hidden = false
                 )) AS answer_count,
              e.status AS last_email_status, e.error AS last_email_error, e.created_at AS last_email_at
       FROM candidates c
       LEFT JOIN LATERAL (
         SELECT status, error, created_at FROM email_log
         WHERE candidate_id = c.id
         ORDER BY created_at DESC
         LIMIT 1
       ) e ON true
       WHERE c.party_id = $1
       ORDER BY c.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/parties/:id/send-candidate-links — email every candidate of
// the party their personal link, e.g. once after migration 011 gave existing
// candidates tokens nobody had seen yet. Sends in the background; each outcome
// lands in email_log and shows up in the candidate list above.
router.post("/:id/send-candidate-links", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    if (!process.env.SMTP_HOST) {
      return res.status(503).json({ error: "Sähköpostin lähetys ei ole käytössä" });
    }
    const { rows: parties } = await db.query("SELECT name FROM parties WHERE id = $1", [req.params.id]);
    if (parties.length === 0) {
      return res.status(404).json({ error: "Puoluetta ei löytynyt" });
    }
    const { rows: candidates } = await db.query(
      "SELECT id, name, email, token FROM candidates WHERE party_id = $1",
      [req.params.id]
    );
    const withEmail = candidates.filter((c) => c.email);
    res.status(202).json({ queued: withEmail.length, withoutEmail: candidates.length - withEmail.length });

    const frontendBaseUrl = process.env.CORS_ORIGIN || "http://localhost:5173";
    const results = await Promise.allSettled(
      withEmail.map((c) => sendCandidateLinkEmail(c, parties[0].name, frontendBaseUrl))
    );
    const failed = results.filter((r) => r.status === "rejected");
    for (const r of failed) console.error("Ehdokaslinkin lähetys epäonnistui:", r.reason);
    console.log(
      `Ehdokaslinkit (${parties[0].name}): ${results.length - failed.length} lähetetty, ${failed.length} epäonnistui`
    );
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/parties/:id — remove a party
router.delete("/:id", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rowCount } = await db.query("DELETE FROM parties WHERE id = $1", [
      req.params.id,
    ]);
    if (rowCount === 0) {
      return res.status(404).json({ error: "Puoluetta ei löytynyt" });
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
