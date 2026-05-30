const { Router } = require("express");
const db = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { isValidLength, isValidUrl, isValidEmail, isValidUUID, validateUUIDParam } = require("../middleware/validation");
const {
  sendNewQuestionSetNotification,
  sendQuestionSetReviewedNotification,
  sendQuestionSetPartialReviewNotification,
  sendQuestionSetPublishedNotification,
  sendApprovedQuestionSetNotificationToCandidate,
  sendApprovedQuestionSetNotificationToParty,
} = require("../email");

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Fetch questions for the given set ids, grouped by set id.
 * Questions are linked to sets via the question_set_questions join table, so a
 * single canonical question may appear under several sets (with a per-set order).
 */
async function fetchQuestionsBySet(setIds) {
  const map = {};
  if (setIds.length === 0) return map;
  const { rows } = await db.query(
    `SELECT qsq.question_set_id, q.id, q.statement, qsq.sort_order
     FROM question_set_questions qsq
     JOIN questions q ON q.id = qsq.question_id
     WHERE qsq.question_set_id = ANY($1)
     ORDER BY qsq.sort_order`,
    [setIds]
  );
  rows.forEach((q) => {
    if (!map[q.question_set_id]) map[q.question_set_id] = [];
    map[q.question_set_id].push({ id: q.id, statement: q.statement, sortOrder: q.sort_order });
  });
  return map;
}

/**
 * Delete any of the given questions that are no longer linked to any set.
 * Deleting a question cascades to its candidate_answers and voter_responses, so
 * this is only called for questions we have just unlinked from their last set.
 */
async function deleteOrphanQuestions(client, questionIds) {
  if (!questionIds || questionIds.length === 0) return;
  await client.query(
    `DELETE FROM questions q
     WHERE q.id = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM question_set_questions l WHERE l.question_id = q.id)`,
    [questionIds]
  );
}

/**
 * Merge the duplicate question `dropId` into the canonical question `keepId`.
 * Caller must run this inside a transaction.
 *
 * - Candidate answers on the duplicate are copied onto the canonical question,
 *   but only for candidates who had not answered the canonical question. If a
 *   candidate answered both, the canonical question's own answer is kept — its
 *   wording is what voters see, and the slightly different duplicate wording may
 *   have drawn a different answer, so we don't let it override.
 * - Anonymous voter responses are copied where they don't already exist.
 * - The duplicate's set links are moved onto the canonical question, so every set
 *   that posed the duplicate now points at the canonical question instead.
 * - The duplicate question is then deleted (cascading any remainder).
 */
async function mergeQuestions(client, keepId, dropId) {
  if (keepId === dropId) return;

  await client.query(
    `INSERT INTO candidate_answers (candidate_id, question_id, value, explanation, answered_at)
     SELECT candidate_id, $1, value, explanation, answered_at
     FROM candidate_answers WHERE question_id = $2
     ON CONFLICT (candidate_id, question_id) DO NOTHING`,
    [keepId, dropId]
  );

  await client.query(
    `INSERT INTO voter_responses (session_id, question_id, value, weight)
     SELECT session_id, $1, value, weight
     FROM voter_responses WHERE question_id = $2
     ON CONFLICT DO NOTHING`,
    [keepId, dropId]
  );

  await client.query(
    `INSERT INTO question_set_questions (question_set_id, question_id, sort_order)
     SELECT question_set_id, $1, sort_order
     FROM question_set_questions WHERE question_id = $2
     ON CONFLICT (question_set_id, question_id) DO NOTHING`,
    [keepId, dropId]
  );

  await client.query("DELETE FROM questions WHERE id = $1", [dropId]);
}

// ─── Public router (/api/question-sets) ──────────────────────────────────────

const publicRouter = Router();

// GET /api/question-sets — list approved, visible sets with their questions
publicRouter.get("/", async (req, res, next) => {
  try {
    const { rows: sets } = await db.query(
      `SELECT qs.id, qs.ngo_name, qs.logo_url, qs.title,
              qs.status, qs.submitted_at, qs.reviewed_at
       FROM question_sets qs
       WHERE qs.status = 'approved' AND qs.hidden = false
       ORDER BY qs.submitted_at`
    );

    const questionsMap = await fetchQuestionsBySet(sets.map((s) => s.id));
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
    if (questions.length > 50) {
      return res.status(400).json({ error: "Liian monta väittämää (maksimi: 50)" });
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

      // Each submitted question starts as its own canonical question linked to this set.
      const { rows: [question] } = await client.query(
        `INSERT INTO questions (statement) VALUES ($1) RETURNING id, statement`,
        [stmt.trim()]
      );
      await client.query(
        `INSERT INTO question_set_questions (question_set_id, question_id, sort_order)
         VALUES ($1, $2, $3)`,
        [qs.id, question.id, i + 1]
      );
      insertedQuestions.push({ id: question.id, statement: question.statement, sortOrder: i + 1 });
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

// POST /api/admin/question-sets/merge-questions — link duplicate questions to a canonical one
// Body: { keepId: "uuid", dropIds: ["uuid", ...] }
adminRouter.post("/merge-questions", requireAdmin, async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { keepId, dropIds } = req.body;

    if (!isValidUUID(keepId)) {
      return res.status(400).json({ error: "Virheellinen säilytettävän kysymyksen tunniste" });
    }
    if (!Array.isArray(dropIds) || dropIds.length === 0) {
      return res.status(400).json({ error: "Vähintään yksi yhdistettävä kysymys vaaditaan" });
    }
    if (!dropIds.every((id) => isValidUUID(id))) {
      return res.status(400).json({ error: "Virheelliset yhdistettävien kysymysten tunnisteet" });
    }
    if (dropIds.includes(keepId)) {
      return res.status(400).json({ error: "Kysymystä ei voi yhdistää itseensä" });
    }

    await client.query("BEGIN");

    // Verify every referenced question exists.
    const allIds = [keepId, ...dropIds];
    const { rows: found } = await client.query(
      "SELECT id FROM questions WHERE id = ANY($1) FOR UPDATE",
      [allIds]
    );
    if (found.length !== allIds.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Kysymystä ei löytynyt" });
    }

    for (const dropId of dropIds) {
      await mergeQuestions(client, keepId, dropId);
    }

    // Return the canonical question with the sets it now belongs to.
    const { rows: [question] } = await client.query(
      "SELECT id, statement FROM questions WHERE id = $1",
      [keepId]
    );
    const { rows: setLinks } = await client.query(
      `SELECT qs.id, qs.title, qs.ngo_name
       FROM question_set_questions qsq
       JOIN question_sets qs ON qs.id = qsq.question_set_id
       WHERE qsq.question_id = $1`,
      [keepId]
    );

    await client.query("COMMIT");
    res.json({ ...question, merged: dropIds.length, sets: setLinks });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/question-sets — list ALL sets (any status)
adminRouter.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows: sets } = await db.query(
      `SELECT qs.id, qs.ngo_name, qs.ngo_email, qs.logo_url, qs.title,
              qs.status, qs.hidden, qs.submitted_at, qs.reviewed_at
       FROM question_sets qs
       ORDER BY
         CASE qs.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         qs.submitted_at`
    );

    const questionsMap = await fetchQuestionsBySet(sets.map((s) => s.id));
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
    const approvedSet = rows[0];
    res.json(approvedSet);

    sendQuestionSetReviewedNotification(approvedSet, true).catch((err) =>
      console.error("NGO-sähköpostin lähetys epäonnistui:", err)
    );

    // Fire-and-forget notifications to candidates and parties
    (async () => {
      try {
        const { rows: [{ count }] } = await db.query(
          "SELECT COUNT(*) FROM question_set_questions WHERE question_set_id = $1",
          [approvedSet.id]
        );
        const questionCount = Number(count);
        const frontendBaseUrl = process.env.CORS_ORIGIN || "http://localhost:5173";

        const { rows: candidates } = await db.query(
          `SELECT DISTINCT c.id, c.name, c.email, p.token AS party_token
           FROM candidates c
           JOIN parties p ON c.party_id = p.id
           WHERE c.email IS NOT NULL
             AND EXISTS (SELECT 1 FROM candidate_answers ca WHERE ca.candidate_id = c.id)`
        );

        const { rows: parties } = await db.query(
          `SELECT DISTINCT p.id, p.name, p.email, p.token
           FROM parties p
           JOIN candidates c ON c.party_id = p.id
           WHERE p.email IS NOT NULL
             AND EXISTS (SELECT 1 FROM candidate_answers ca WHERE ca.candidate_id = c.id)`
        );

        for (const c of candidates) {
          sendApprovedQuestionSetNotificationToCandidate(approvedSet, questionCount, c, frontendBaseUrl)
            .catch((err) => console.error("Ehdokkaan sähköpostin lähetys epäonnistui:", err));
        }
        for (const p of parties) {
          sendApprovedQuestionSetNotificationToParty(approvedSet, questionCount, p, frontendBaseUrl)
            .catch((err) => console.error("Puolueen sähköpostin lähetys epäonnistui:", err));
        }
      } catch (err) {
        console.error("Hyväksyntäilmoitusten lähetys epäonnistui:", err);
      }
    })();
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
    sendQuestionSetReviewedNotification(rows[0], false).catch((err) =>
      console.error("NGO-sähköpostin lähetys epäonnistui:", err)
    );
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/question-sets/:id/review — per-question accept/edit/reject/merge
adminRouter.patch("/:id/review", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { reviews } = req.body;
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return res.status(400).json({ error: "reviews-kenttä vaaditaan" });
    }

    await client.query("BEGIN");

    const { rows: sets } = await client.query(
      "SELECT * FROM question_sets WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }
    // Validate edits and merge targets
    for (const r of reviews) {
      if (r.editedStatement != null && !isValidLength(r.editedStatement, 500)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Muokattu väittämä on liian pitkä (maksimi: 500 merkkiä)" });
      }
      if (r.duplicateOf != null && !isValidUUID(r.duplicateOf)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Virheellinen kaksoiskappaleen tunniste" });
      }
    }

    const rejectedReviews = reviews.filter((r) => r.rejected);
    const mergedReviews = reviews.filter((r) => !r.rejected && r.duplicateOf);
    const editedReviews = reviews.filter((r) => !r.rejected && !r.duplicateOf && r.editedStatement?.trim());

    // Fetch originals for rejected and edited questions (needed for email)
    const needOriginalIds = [
      ...rejectedReviews.map((r) => r.questionId),
      ...editedReviews.map((r) => r.questionId),
    ];
    let originalRows = [];
    if (needOriginalIds.length > 0) {
      const { rows } = await client.query(
        `SELECT q.id, q.statement
         FROM questions q
         JOIN question_set_questions qsq ON qsq.question_id = q.id
         WHERE q.id = ANY($1) AND qsq.question_set_id = $2`,
        [needOriginalIds, req.params.id]
      );
      originalRows = rows;
    }

    // Apply edits (edits change the canonical question, affecting every set that shares it)
    for (const edit of editedReviews) {
      await client.query(
        `UPDATE questions q SET statement = $1
         FROM question_set_questions qsq
         WHERE q.id = $2 AND qsq.question_id = q.id AND qsq.question_set_id = $3`,
        [edit.editedStatement.trim(), edit.questionId, req.params.id]
      );
    }

    // Merge duplicates into their canonical questions. mergeQuestions moves this
    // set's link onto the canonical question, so the set keeps the question (just
    // de-duplicated) rather than losing it.
    for (const m of mergedReviews) {
      await mergeQuestions(client, m.duplicateOf, m.questionId);
    }

    // Reject (unlink from this set, then delete the question if it's now orphaned)
    let rejectedQuestionsInfo = [];
    if (rejectedReviews.length > 0) {
      const rejectedIds = rejectedReviews.map((r) => r.questionId);
      rejectedQuestionsInfo = rejectedReviews
        .map((r) => {
          const original = originalRows.find((o) => o.id === r.questionId);
          return original ? { statement: original.statement, rejectionReason: r.rejectionReason || "" } : null;
        })
        .filter(Boolean);
      await client.query(
        "DELETE FROM question_set_questions WHERE question_id = ANY($1) AND question_set_id = $2",
        [rejectedIds, req.params.id]
      );
      await deleteOrphanQuestions(client, rejectedIds);
    }

    // Fetch remaining questions (with updated statements)
    const { rows: remainingQuestions } = await client.query(
      `SELECT q.id, q.statement
       FROM question_set_questions qsq
       JOIN questions q ON q.id = qsq.question_id
       WHERE qsq.question_set_id = $1
       ORDER BY qsq.sort_order`,
      [req.params.id]
    );
    const newStatus = remainingQuestions.length > 0 ? "approved" : "rejected";
    const newHidden = newStatus === "approved";

    const { rows: updatedRows } = await client.query(
      "UPDATE question_sets SET status = $1, hidden = $2, reviewed_at = now() WHERE id = $3 RETURNING *",
      [newStatus, newHidden, req.params.id]
    );
    const updatedSet = updatedRows[0];

    await client.query("COMMIT");

    res.json(updatedSet);

    // Build email data: split remaining into accepted-as-is vs modified
    const editedIds = new Set(editedReviews.map((r) => r.questionId));
    const acceptedQuestions = remainingQuestions.filter((q) => !editedIds.has(q.id));
    const modifiedQuestions = editedReviews
      .map((edit) => {
        const original = originalRows.find((o) => o.id === edit.questionId);
        const updated = remainingQuestions.find((r) => r.id === edit.questionId);
        return original && updated ? { originalStatement: original.statement, editedStatement: updated.statement } : null;
      })
      .filter(Boolean);

    sendQuestionSetPartialReviewNotification(updatedSet, acceptedQuestions, modifiedQuestions, rejectedQuestionsInfo).catch(
      (err) => console.error("NGO-sähköpostin lähetys epäonnistui:", err)
    );
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/admin/question-sets/:id/hide
adminRouter.patch("/:id/hide", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE question_sets SET hidden = true WHERE id = $1 RETURNING *`,
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

// PATCH /api/admin/question-sets/:id/unhide — publish a staged set
adminRouter.patch("/:id/unhide", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE question_sets SET hidden = false WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }
    const publishedSet = rows[0];
    res.json(publishedSet);

    (async () => {
      try {
        const { rows: [{ count }] } = await db.query(
          "SELECT COUNT(*) FROM question_set_questions WHERE question_set_id = $1",
          [publishedSet.id]
        );
        const questionCount = Number(count);
        const frontendBaseUrl = process.env.CORS_ORIGIN || "http://localhost:5173";

        sendQuestionSetPublishedNotification(publishedSet, questionCount).catch(
          (err) => console.error("NGO-sähköpostin lähetys epäonnistui:", err)
        );

        const { rows: candidates } = await db.query(
          `SELECT DISTINCT c.id, c.name, c.email, p.token AS party_token
           FROM candidates c
           JOIN parties p ON c.party_id = p.id
           WHERE c.email IS NOT NULL
             AND EXISTS (SELECT 1 FROM candidate_answers ca WHERE ca.candidate_id = c.id)`
        );
        const { rows: parties } = await db.query(
          `SELECT DISTINCT p.id, p.name, p.email, p.token
           FROM parties p
           JOIN candidates c ON c.party_id = p.id
           WHERE p.email IS NOT NULL
             AND EXISTS (SELECT 1 FROM candidate_answers ca WHERE ca.candidate_id = c.id)`
        );
        for (const c of candidates) {
          sendApprovedQuestionSetNotificationToCandidate(publishedSet, questionCount, c, frontendBaseUrl)
            .catch((err) => console.error("Ehdokkaan sähköpostin lähetys epäonnistui:", err));
        }
        for (const p of parties) {
          sendApprovedQuestionSetNotificationToParty(publishedSet, questionCount, p, frontendBaseUrl)
            .catch((err) => console.error("Puolueen sähköpostin lähetys epäonnistui:", err));
        }
      } catch (err) {
        console.error("Julkaisuilmoitusten lähetys epäonnistui:", err);
      }
    })();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/question-sets/:id/questions — add a question to a staged set
adminRouter.post("/:id/questions", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { statement } = req.body;
    if (!statement?.trim()) {
      return res.status(400).json({ error: "Väittämä vaaditaan" });
    }
    if (!isValidLength(statement, 500)) {
      return res.status(400).json({ error: "Väittämä on liian pitkä (maksimi: 500 merkkiä)" });
    }

    const { rows: sets } = await client.query(
      "SELECT id, status, hidden FROM question_sets WHERE id = $1",
      [req.params.id]
    );
    if (sets.length === 0) {
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }
    if (sets[0].status !== "approved" || !sets[0].hidden) {
      return res.status(409).json({ error: "Kysymyksiä voi lisätä vain julkaisemattomiin kysymyssarjoihin" });
    }

    await client.query("BEGIN");

    const { rows: [{ max }] } = await client.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max FROM question_set_questions WHERE question_set_id = $1",
      [req.params.id]
    );
    const sortOrder = Number(max) + 1;

    const { rows: [question] } = await client.query(
      "INSERT INTO questions (statement) VALUES ($1) RETURNING id, statement",
      [statement.trim()]
    );
    await client.query(
      "INSERT INTO question_set_questions (question_set_id, question_id, sort_order) VALUES ($1, $2, $3)",
      [req.params.id, question.id, sortOrder]
    );

    await client.query("COMMIT");
    res.status(201).json({ id: question.id, statement: question.statement, sortOrder });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/admin/question-sets/:id/questions/:questionId — remove a question from a staged set
adminRouter.delete(
  "/:id/questions/:questionId",
  requireAdmin,
  validateUUIDParam("id"),
  validateUUIDParam("questionId"),
  async (req, res, next) => {
    const client = await db.getClient();
    try {
      const { rows: sets } = await client.query(
        "SELECT id, status, hidden FROM question_sets WHERE id = $1",
        [req.params.id]
      );
      if (sets.length === 0) {
        return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
      }
      if (sets[0].status !== "approved" || !sets[0].hidden) {
        return res.status(409).json({ error: "Kysymyksiä voi poistaa vain julkaisemattomista kysymyssarjoista" });
      }

      await client.query("BEGIN");
      const { rowCount } = await client.query(
        "DELETE FROM question_set_questions WHERE question_id = $1 AND question_set_id = $2",
        [req.params.questionId, req.params.id]
      );
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Kysymystä ei löytynyt" });
      }
      // Drop the canonical question if it's no longer used by any set.
      await deleteOrphanQuestions(client, [req.params.questionId]);
      await client.query("COMMIT");
      res.status(204).end();
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

// DELETE /api/admin/question-sets/:id
adminRouter.delete("/:id", requireAdmin, validateUUIDParam("id"), async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Remember which questions this set held so we can clean up any that become orphaned.
    const { rows: linked } = await client.query(
      "SELECT question_id FROM question_set_questions WHERE question_set_id = $1",
      [req.params.id]
    );

    const { rowCount } = await client.query(
      `DELETE FROM question_sets WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Kysymyssarjaa ei löytynyt" });
    }

    // Set deletion cascaded the join rows; remove questions no other set still shares.
    await deleteOrphanQuestions(client, linked.map((l) => l.question_id));

    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

module.exports = { publicRouter, adminRouter };
