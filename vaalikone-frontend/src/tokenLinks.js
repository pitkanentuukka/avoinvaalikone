// Magic links: the token-carrying query params that open the party, register
// and candidate views. Kept free of Vite-only syntax so the unit tests can
// import it under Node.

const STORAGE_KEY = "vaalikone_link";
const TOKEN_VIEWS = ["candidate", "register", "party"];

// Real tokens are hex, so whitespace in one is a pasting or line-wrapping
// accident. The browser used to drop tabs and newlines from the request path;
// now that tokens are encoded (api.js) they would reach the server and miss.
export function cleanToken(token) {
  return token ? token.replace(/\s+/g, "") : token;
}

// Map magic-link query params to the view they open. Candidate links win over
// the others so an old link carrying several params lands somewhere sensible.
export function tokenLinkFromParams(params) {
  const candidateToken = cleanToken(params.get("candidateToken"));
  if (candidateToken) return { view: "candidate", token: candidateToken };
  // Answering links sent before personal links existed
  // (?view=candidate&partyToken=…&candidateId=…). They carry the party token,
  // which now opens the secretary's portal — never open it from one of these.
  if (params.get("candidateId")) return { view: "legacy", token: null };
  const registrationToken = cleanToken(params.get("register"));
  if (registrationToken) return { view: "register", token: registrationToken };
  const partyToken = cleanToken(params.get("partyToken"));
  if (partyToken) return { view: "party", token: partyToken };
  return null;
}

// The open link is kept in the tab's sessionStorage (`storage`, null when
// unavailable) so a reload can reopen it after the token has been scrubbed
// from the address bar. Pass null to forget it.
export function rememberLink(storage, link) {
  try {
    if (link && TOKEN_VIEWS.includes(link.view) && link.token) {
      storage?.setItem(STORAGE_KEY, JSON.stringify(link));
    } else {
      storage?.removeItem(STORAGE_KEY);
    }
  } catch { /* storage blocked or full: a reload just won't recover the link */ }
}

function rememberedLink(storage) {
  try {
    const link = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (link && TOKEN_VIEWS.includes(link.view) && typeof link.token === "string" && link.token) return link;
  } catch { /* blocked or corrupt */ }
  return null;
}

// The link to open on page load: one in the URL (`search`) wins and replaces
// any remembered one. Otherwise the remembered one, but only on a reload
// (`navigationType`, from the Navigation Timing API): sessionStorage outlives
// visits to other sites in the same tab, so on a shared computer the next
// person to type the address would land in someone else's portal. Back and
// Forward (and reopened tabs) are excluded on purpose for the same reason.
export function readInitialLink(search, storage, navigationType) {
  const link = tokenLinkFromParams(new URLSearchParams(search));
  if (!link && navigationType === "reload") return rememberedLink(storage);
  rememberLink(storage, link);
  return link;
}
