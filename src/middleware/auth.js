const crypto = require("crypto");
const db = require("../db/pool");

/**
 * Admin auth via Bearer token (timing-safe comparison).
 * Header: Authorization: Bearer <ADMIN_SECRET>
 */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Tunnistautuminen vaaditaan" });
  }
  const token = auth.slice(7);
  const adminSecret = process.env.ADMIN_SECRET;
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    const tokenBuffer = Buffer.from(token);
    const secretBuffer = Buffer.from(adminSecret);
    
    if (tokenBuffer.length !== secretBuffer.length || !crypto.timingSafeEqual(tokenBuffer, secretBuffer)) {
      return res.status(403).json({ error: "Virheellinen ylläpitotunniste" });
    }
  } catch (err) {
    // timingSafeEqual throws if lengths don't match
    return res.status(403).json({ error: "Virheellinen ylläpitotunniste" });
  }
  
  next();
}

/**
 * Party token auth.
 * Looks up the party by token from the URL param :partyToken
 * and attaches req.party = { id, name, token, email }.
 */
async function requirePartyToken(req, res, next) {
  const { partyToken } = req.params;
  if (!partyToken) {
    return res.status(400).json({ error: "Puoluetunniste puuttuu" });
  }
  try {
    const { rows } = await db.query(
      "SELECT id, name, token, email FROM parties WHERE token = $1",
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

module.exports = { requireAdmin, requirePartyToken };
