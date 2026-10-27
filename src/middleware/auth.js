const crypto = require("crypto");
const db = require("../db/pool");

/**
 * Admin auth via Bearer token (timing-safe comparison).
 * Header: Authorization: Bearer <ADMIN_SECRET>
 */
/**
 * Returns true iff the request carries a valid admin Bearer token. Does not
 * send a response — for handlers that only want to *vary* on admin-ness
 * (e.g. /api/health exposing pool internals) rather than gate access.
 */
function isAdminRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || !process.env.ADMIN_SECRET) {
    return false;
  }
  // Hash both values to a fixed length before comparing so the secret's
  // length cannot be inferred from timing (timingSafeEqual requires equal lengths).
  const tokenHash  = crypto.createHash("sha256").update(Buffer.from(auth.slice(7))).digest();
  const secretHash = crypto.createHash("sha256").update(Buffer.from(process.env.ADMIN_SECRET)).digest();
  return crypto.timingSafeEqual(tokenHash, secretHash);
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Tunnistautuminen vaaditaan" });
  }
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: "Virheellinen ylläpitotunniste" });
  }
  next();
}

/**
 * Party token auth — the party secretary's management access.
 * Looks up the party by token from the URL param :partyToken
 * and attaches req.party = { id, name, token, email, registration_token }.
 */
async function requirePartyToken(req, res, next) {
  const { partyToken } = req.params;
  if (!partyToken) {
    return res.status(400).json({ error: "Puoluetunniste puuttuu" });
  }
  try {
    const { rows } = await db.query(
      "SELECT id, name, token, email, registration_token FROM parties WHERE token = $1",
      [partyToken]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Virheellinen puoluetunniste" });
    }
    req.party = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Candidate token auth — the candidate's personal link.
 * Looks up the candidate by URL param :candidateToken and attaches
 * req.candidate = { id, party_id, party_name }.
 */
async function requireCandidateToken(req, res, next) {
  const { candidateToken } = req.params;
  if (!candidateToken) {
    return res.status(400).json({ error: "Ehdokastunniste puuttuu" });
  }
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.party_id, p.name AS party_name
       FROM candidates c
       JOIN parties p ON p.id = c.party_id
       WHERE c.token = $1`,
      [candidateToken]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Virheellinen ehdokastunniste" });
    }
    req.candidate = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Registration link auth — the party's shareable sign-up link.
 * Looks up the party by URL param :registrationToken and attaches
 * req.party = { id, name }. Grants nothing beyond creating a candidate.
 */
async function requireRegistrationToken(req, res, next) {
  const { registrationToken } = req.params;
  if (!registrationToken) {
    return res.status(400).json({ error: "Rekisteröitymistunniste puuttuu" });
  }
  try {
    const { rows } = await db.query(
      "SELECT id, name FROM parties WHERE registration_token = $1",
      [registrationToken]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Virheellinen rekisteröitymislinkki" });
    }
    req.party = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireAdmin,
  requirePartyToken,
  requireCandidateToken,
  requireRegistrationToken,
  isAdminRequest,
};
