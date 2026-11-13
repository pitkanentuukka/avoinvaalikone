// Masks party, registration and candidate tokens in what Sentry records: the
// URLs of API calls (fetch breadcrumbs), the page URL, and the navigation from
// a magic link when the app scrubs it from the address bar (issue #36). They're
// bearer secrets that never expire. Kept free of Vite-only syntax so the unit
// tests can import it under Node.
//
// Keep in step with src/redactTokens.js in the backend;
// tests/unit/redactTokens.test.js runs the same cases against both.

// API paths: /candidates/me/<token>, /candidates/party/<token>/…,
// /candidates/register/<token>. Case-insensitive like Express's routing.
const PATH_TOKEN = /(\/candidates\/(?:me|party|register)\/)[^/?#\s"'<>]+/gi;
// Magic-link query params (tokenLinks.js).
const QUERY_TOKEN = /([?&](?:candidateToken|register|partyToken)=)[^&#\s"'<>]+/g;

export function redactTokens(str) {
  return str.replace(PATH_TOKEN, "$1[token]").replace(QUERY_TOKEN, "$1[token]");
}

// A copy of `value` with every string in it masked, at any depth. Objects
// other than plain objects and arrays are kept as they are.
export function redactTokensDeep(value, seen = new Map()) {
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

// For Sentry.init in main.jsx. Breadcrumbs are masked as they're recorded, and
// the whole event again before it's sent (request URL, error messages, …).
// Transactions skip beforeSend; there are none while tracing is off, but if it
// is turned on their names and span URLs are masked too.
export const sentryRedaction = {
  beforeBreadcrumb: (breadcrumb) => redactTokensDeep(breadcrumb),
  beforeSend: (event) => redactTokensDeep(event),
  beforeSendTransaction: (event) => redactTokensDeep(event),
};
