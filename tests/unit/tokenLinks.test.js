// Loaded with import() like apiClient.test.js: the frontend is an ES module package.
let readInitialLink, rememberLink, tokenLinkFromParams;
beforeAll(async () => {
  ({ readInitialLink, rememberLink, tokenLinkFromParams } = await import("../../vaalikone-frontend/src/tokenLinks.js"));
});

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const throwingStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};

describe("tokenLinkFromParams", () => {
  test.each([
    ["?candidateToken=abc", { view: "candidate", token: "abc" }],
    ["?register=abc", { view: "register", token: "abc" }],
    ["?partyToken=abc", { view: "party", token: "abc" }],
    ["?view=candidate&partyToken=abc&candidateId=1", { view: "legacy", token: null }],
    ["?candidateToken=c&partyToken=p", { view: "candidate", token: "c" }],
    ["", null],
  ])("%s", (search, expected) => {
    expect(tokenLinkFromParams(new URLSearchParams(search))).toEqual(expected);
  });
});

// The token is scrubbed from the address bar once read, so a reload has to
// recover it from the tab's sessionStorage. Only a reload: see below.
describe("readInitialLink", () => {
  test("a link in the URL is returned and remembered for a reload", () => {
    const storage = memoryStorage();
    expect(readInitialLink("?candidateToken=abc", storage)).toEqual({ view: "candidate", token: "abc" });
    expect(readInitialLink("", storage, "reload")).toEqual({ view: "candidate", token: "abc" });
  });

  test("a link in the URL wins over the remembered one", () => {
    const storage = memoryStorage();
    readInitialLink("?candidateToken=old", storage);
    expect(readInitialLink("?partyToken=new", storage)).toEqual({ view: "party", token: "new" });
    expect(readInitialLink("", storage, "reload")).toEqual({ view: "party", token: "new" });
  });

  // sessionStorage outlives visits to other sites in the same tab, so on a
  // shared computer the next person typing the address would get the link.
  test.each(["navigate", "back_forward", undefined])("a %s load with nothing in the URL forgets the link", (type) => {
    const storage = memoryStorage();
    readInitialLink("?partyToken=abc", storage);
    expect(readInitialLink("", storage, type)).toBeNull();
    expect(readInitialLink("", storage, "reload")).toBeNull();
  });

  test("with nothing in the URL or storage there is no link", () => {
    expect(readInitialLink("", memoryStorage(), "reload")).toBeNull();
  });

  test("the just-registered flag survives a reload", () => {
    const storage = memoryStorage();
    rememberLink(storage, { view: "candidate", token: "abc", justRegistered: true });
    expect(readInitialLink("", storage, "reload")).toEqual({ view: "candidate", token: "abc", justRegistered: true });
  });

  test("forgetting the link clears it", () => {
    const storage = memoryStorage();
    readInitialLink("?candidateToken=abc", storage);
    rememberLink(storage, null);
    expect(readInitialLink("", storage, "reload")).toBeNull();
  });

  // Holds no secret, so there is nothing to recover.
  test("a legacy link is not remembered", () => {
    const storage = memoryStorage();
    expect(readInitialLink("?view=candidate&partyToken=p&candidateId=1", storage)).toEqual({ view: "legacy", token: null });
    expect(readInitialLink("", storage, "reload")).toBeNull();
  });

  test("a corrupt stored value is ignored", () => {
    const storage = memoryStorage();
    storage.setItem("vaalikone_link", "{not json");
    expect(readInitialLink("", storage, "reload")).toBeNull();
    storage.setItem("vaalikone_link", JSON.stringify({ view: "admin", token: "x" }));
    expect(readInitialLink("", storage, "reload")).toBeNull();
  });

  test.each([["unavailable", null], ["throwing", throwingStorage]])("works with %s storage", (_, storage) => {
    expect(readInitialLink("?candidateToken=abc", storage)).toEqual({ view: "candidate", token: "abc" });
    expect(readInitialLink("", storage, "reload")).toBeNull();
    expect(() => rememberLink(storage, null)).not.toThrow();
  });
});
