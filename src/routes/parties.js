const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../db/pool");
const { requireAdmin } = require("../middleware/auth");
const { isValidLength, isValidEmail, validateUUIDParam } = require("../middleware/validation");

const router = Router();

// GET /api/admin/parties — list all parties
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT id, name, token, email, created_at FROM parties ORDER BY created_at"
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
    if (!name?.trim()) {
      return res.status(400).json({ error: "Puolueen nimi vaaditaan" });
    }
    
    // Validate field lengths
    if (!isValidLength(name, 100)) {
      return res.status(400).json({ error: "Puolueen nimi on liian pitkä (maksimi: 100 merkkiä)" });
    }
    if (email && !isValidLength(email, 255)) {
      return res.status(400).json({ error: "Sähköpostiosoite on liian pitkä (maksimi: 255 merkkiä)" });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: "Virheellinen sähköpostiosoite" });
    }

    // Generate a URL-safe token
    const slug = name
      .toLowerCase()
      .replace(/[äå]/g, "a")
      .replace(/ö/g, "o")
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 12);
    const token = `${slug}-${uuidv4().slice(0, 8)}`;

    const { rows } = await db.query(
      `INSERT INTO parties (name, token, email)
       VALUES ($1, $2, $3)
       RETURNING id, name, token, email, created_at`,
      [name.trim(), token, email?.trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Puolue on jo olemassa" });
    }
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
