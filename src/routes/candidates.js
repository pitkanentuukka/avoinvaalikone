const { Router } = require("express");
const db = require("../db/pool");
const { requirePartyToken } = require("../middleware/auth");
const { isValidLength, isValidUrl, isValidEmail, validateUUIDParam, isValidUUID } = require("../middleware/validation");

const router = Router();

// ─── Public ───

// GET /api/candidates — list all candidates with party info
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.bio, c.created_at,
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
router.get("/:id", validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows: cRows } = await db.query(
      `SELECT c.id, c.name, c.photo_url, c.bio, c.created_at,
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

    res.json({
      ...cRows[0],
      answers: answers.reduce((acc, a) => {
        acc[a.question_id] = {
          value: a.value,
          explanation: a.explanation,
          answeredAt: a.answered_at,
        };
        return acc;
      }, {}),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Party-token gated ───

// GET /api/party/:partyToken/candidates — list candidates for this party
router.get(
  "/party/:partyToken",
  requirePartyToken,
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.photo_url, c.bio,
                (SELECT COUNT(*) FROM candidate_answers ca WHERE ca.candidate_id = c.id) AS answer_count
         FROM candidates c
         WHERE c.party_id = $1
         ORDER BY c.name`,
        [req.party.id]
      );
      res.json({
        party: { id: req.party.id, name: req.party.name },
        candidates: rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/party/:partyToken/candidates — register new candidate
router.post(
  "/party/:partyToken",
  requirePartyToken,
  async (req, res, next) => {
    try {
      const { name, photoUrl, bio, email } = req.body;
      if (!name?.trim()) {
        return res.status(400).json({ error: "Ehdokkaan nimi vaaditaan" });
      }

      // Validate field lengths
      if (!isValidLength(name, 255)) {
        return res.status(400).json({ error: "Ehdokkaan nimi on liian pitkä (maksimi: 255 merkkiä)" });
      }
      if (photoUrl && !isValidLength(photoUrl, 500)) {
        return res.status(400).json({ error: "Kuvan URL on liian pitkä (maksimi: 500 merkkiä)" });
      }
      if (photoUrl && !isValidUrl(photoUrl)) {
        return res.status(400).json({ error: "Kuvan URL on virheellinen (vaaditaan http:// tai https://)" });
      }
      if (bio && !isValidLength(bio, 1000)) {
        return res.status(400).json({ error: "Biografia on liian pitkä (maksimi: 1000 merkkiä)" });
      }
      if (email && !isValidLength(email, 255)) {
        return res.status(400).json({ error: "Sähköpostiosoite on liian pitkä (maksimi: 255 merkkiä)" });
      }
      if (email && !isValidEmail(email)) {
        return res.status(400).json({ error: "Sähköpostiosoite on virheellinen" });
      }

      const { rows } = await db.query(
        `INSERT INTO candidates (party_id, name, photo_url, bio, email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, photo_url, bio, email, created_at`,
        [req.party.id, name.trim(), photoUrl?.trim() || null, bio?.trim() || null, email?.trim() || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/party/:partyToken/candidates/:id — update candidate profile
router.put(
  "/party/:partyToken/candidates/:id",
  requirePartyToken,
  validateUUIDParam("id"),
  async (req, res, next) => {
    try {
      const { name, photoUrl, bio } = req.body;

      // Validate field lengths
      if (name && !isValidLength(name, 255)) {
        return res.status(400).json({ error: "Ehdokkaan nimi on liian pitkä (maksimi: 255 merkkiä)" });
      }
      if (photoUrl && !isValidLength(photoUrl, 500)) {
        return res.status(400).json({ error: "Kuvan URL on liian pitkä (maksimi: 500 merkkiä)" });
      }
      if (photoUrl && !isValidUrl(photoUrl)) {
        return res.status(400).json({ error: "Kuvan URL on virheellinen (vaaditaan http:// tai https://)" });
      }
      if (bio && !isValidLength(bio, 1000)) {
        return res.status(400).json({ error: "Biografia on liian pitkä (maksimi: 1000 merkkiä)" });
      }

      // Verify candidate belongs to this party
      const { rows: existing } = await db.query(
        "SELECT id FROM candidates WHERE id = $1 AND party_id = $2",
        [req.params.id, req.party.id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Ehdokasta ei löytynyt tässä puolueessa" });
      }

      const { rows } = await db.query(
        `UPDATE candidates
         SET name = COALESCE($1, name),
             photo_url = $2,
             bio = $3,
             updated_at = now()
         WHERE id = $4
         RETURNING id, name, photo_url, bio, updated_at`,
        [name?.trim(), photoUrl?.trim() || null, bio?.trim() || null, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/party/:partyToken/candidates/:id/answers — save all answers (upsert)
router.put(
  "/party/:partyToken/candidates/:id/answers",
  requirePartyToken,
  validateUUIDParam("id"),
  async (req, res, next) => {
    const client = await db.getClient();
    try {
      const { answers } = req.body;
      // answers: { [questionId]: { value: 0-4, explanation?: string } }

      if (!answers || typeof answers !== "object") {
        return res.status(400).json({ error: "Vastaukset vaaditaan" });
      }

      // Verify candidate belongs to this party
      const { rows: existing } = await client.query(
        "SELECT id FROM candidates WHERE id = $1 AND party_id = $2",
        [req.params.id, req.party.id]
      );
      if (existing.length === 0) {
        return res.status(404).json({ error: "Ehdokasta ei löytynyt tässä puolueessa" });
      }

      await client.query("BEGIN");

      let count = 0;
      for (const [questionId, answer] of Object.entries(answers)) {
        // Validate question ID is a valid UUID
        if (!isValidUUID(questionId)) {
          continue;
        }
        
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
          [req.params.id, questionId, value, answer.explanation?.trim() || ""]
        );
        count++;
      }

      await client.query(
        "UPDATE candidates SET updated_at = now() WHERE id = $1",
        [req.params.id]
      );

      await client.query("COMMIT");
      res.json({ saved: count });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
