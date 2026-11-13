// Masks party, registration and candidate tokens in anything that records a
// URL: Sentry events and the access log (issue #36). They're bearer secrets
// that never expire, so a token in Sentry or in the container logs is working
// edit access to a candidate's profile and answers until an admin rotates it.
//
// Keep in step with vaalikone-frontend/src/redactTokens.js (the backend image
// is built without the frontend); tests/unit/redactTokens.test.js runs the
// same cases against both.

// API paths: /candidates/me/<token>, /candidates/party/<token>/…,
// /candidates/register/<token>. Case-insensitive like Express's routing.
const PATH_TOKEN = /(\/candidates\/(?:me|party|register)\/)[^/?#\s"'<>]+/gi;
// Magic-link query params (tokenLinks.js).
const QUERY_TOKEN = /([?&](?:candidateToken|register|partyToken)=)[^&#\s"'<>]+/g;

function redactTokens(str) {
  return str.replace(PATH_TOKEN, "$1[token]").replace(QUERY_TOKEN, "$1[token]");
}

// A copy of `value` with every string in it masked, at any depth. Objects
// other than plain objects and arrays are kept as they are.
function redactTokensDeep(value, seen = new Map()) {
  if (typeof value === "string") return redactTokens(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(redactTokensDeep(item, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = redactTokensDeep(item, seen);
  return out;
}

module.exports = { redactTokens, redactTokensDeep };
