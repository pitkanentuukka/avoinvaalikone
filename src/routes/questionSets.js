const { Router } = require("express");
const db = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { isValidLength, isValidUrl, isValidEmail, validateUUIDParam } = require("../middleware/validation");
const { sendNewQuestionSetNotification } = require("../email");

// ─── Public router (/api/question-sets) ──────────────────────────────────────

const publicRouter = Router();

// GET /api/question-sets — list approved sets with their questions
publicRouter.get("/", async (req, res, next) => {
  try {
    const { rows: sets } = await db.query(
      `SELECT qs.id, qs.ngo_name, qs.ngo_email, qs.logo_url, qs.title,
              qs.status, qs.submitted_at, qs.reviewed_at
       FROM question_sets qs
       WHERE qs.status = 'approved'
       ORDER BY qs.submitted_at`
    );

    // Fetch questions for each set
    const setIds = sets.map((s) => s.id);
    let questionsMap = {};
    if (setIds.length > 0) {
      const { rows: questions } = await db.query(
        `SELECT id, question_set_id, statement, sort_order
         FROM questions
         WHERE question_set_id = ANY($1)
         ORDER BY sort_order`,
        [setIds]
      );
      questions.forEach((q) => {
        if (!questionsMap[q.question_set_id]) questionsMap[q.question_set_id] = [];
        questionsMap[q.question_set_id].push({
          id: q.id,
          statement: q.statement,
          sortOrder: q.sort_order,
        });
      });
    }

    res.json(sets.map((s) => ({ ...s, questions: questionsMap[s.id] || [] })));
  } catch (err) {
    next(err);
  }
});

// POST /api/question-sets — submit a new question set
publicRouter.post("/", async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { ngoName, ngoEmail, logoUrl, title, questions } = req.body;

    if (!ngoName?.trim() || !title?.trim()) {
      return res
        .status(400)
        .json({ error: "Järjestön nimi ja otsikko vaaditaan" });
    }

    // Validate field lengths
    if (!isValidLength(ngoName, 255)) {
      return res.status(400).json({ error: "Järjestön nimi on liian pitkä (maksimi: 255 merkkiä)" });
    }
    if (!isValidLength(title, 255)) {
      return res.status(400).json({ error: "Otsikko on liian pitkä (maksimi: 255 merkkiä)" });
    }
    if (ngoEmail && !isValidLength(ngoEmail, 255)) {
      return res.status(400).json({ error: "Sähköpostiosoite on liian pitkä (maksimi: 255 merkkiä)" });
    }
    if (ngoEmail && !isValidEmail(ngoEmail)) {
      return res.status(400).json({ error: "Virheellinen sähköpostiosoite" });
    }
    if (logoUrl && !isValidLength(logoUrl, 500)) {
      return res.status(400).json({ error: "Logon URL on liian pitkä (maksimi: 500 merkkiä)" });
    }
    if (logoUrl && !isValidUrl(logoUrl)) {
      return res.status(400).json({ error: "Logon URL on virheellinen (vaaditaan http:// tai https://)" });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res
        .status(400)
        .json({ error: "Vähintään yksi väittämä vaaditaan" });
    }

    await client.query("BEGIN");

    const { rows: setRows } = await client.query(
      `INSERT INTO question_sets (ngo_name, ngo_email, logo_url, title, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [ngoName.trim(), ngoEmail?.trim() || null, logoUrl?.trim() || null, title.trim()]
    );
    const qs = setRows[0];

    const insertedQuestions = [];
    for (let i = 0; i < questions.length; i++) {
      const stmt = questions[i]?.statement || questions[i]; // accept string or object
      if (typeof stmt !== "string" || !stmt.trim()) continue;

      // Validate statement length
      if (!isValidLength(stmt, 500)) {
        continue;
      }

      const { rows } = await client.query(
        `INSERT INTO questions (question_set_id, statement, sort_order)
         VALUES ($1, $2, $3) RETURNING id, statement, sort_order`,
        [qs.id, stmt.trim(), i + 1]
      );
      insertedQuestions.push(rows[0]);
    }

    await client.query("COMMIT");

    // Fire-and-forget: don't block the response if email fails
    sendNewQuestionSetNotification(qs).catch((err) =>
      console.error("Sähköpostin lähetys epäonnistui:", err)
    );

    res.status(201).json({ ...qs, questions: insertedQuestions });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// ─── Admin router (/api/admin/question-sets) ──────────────────────────────────

const adminRouter = Router();

// GET /api/admin/question-sets — list ALL sets (any status)
adminRouter.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows: sets } = await db.query(
      `SELECT qs.id, qs.ngo_name, qs.ngo_email, qs.logo_url, qs.title,
              qs.status, qs.submitted_at, qs.reviewed_at
       FROM question_sets qs
       ORDER BY
         CASE qs.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         qs.submitted_at`
    );

    const setIds = sets.map((s) => s.id);
    let questionsMap = {};
    if (setIds.length > 0) {
      const { rows: questions } = await db.query(
        `SELECT id, question_set_id, statement, sort_order
         FROM questions WHERE question_set_id = ANY($1)
         ORDER BY sort_order`,
        [setIds]
      );
      questions.forEach((q) => {
        if (!questionsMap[q.question_set_id]) questionsMap[q.question_set_id] = [];
        questionsMap[q.question_set_id].push({
          id: q.id,
          statement: q.statement,
          sortOrder: q.sort_order,
        });
      });
    }

    res.json(sets.map((s) => ({ ...s, questions: questionsMap[s.id] || [] })));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/question-sets/:id/approve
adminRouter.patch("/:id/approve", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE question_sets SET status = 'approved', reviewed_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/question-sets/:id/reject
adminRouter.patch("/:id/reject", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE question_sets SET status = 'rejected', reviewed_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = { publicRouter, adminRouter };
