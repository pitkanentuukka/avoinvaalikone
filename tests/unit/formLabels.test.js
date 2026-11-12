// Every form field must have an accessible name (issue #20): a placeholder
// alone isn't one, and a visible <label> only counts when it points at the
// field with `for`. Components are rendered to static HTML and the name is
// worked out from the markup, the way a screen reader would find it.
const { loadFrontend } = require("../helpers/frontendBundle");

let ui, t, h;
beforeAll(async () => {
  ui = await loadFrontend(`
    export * from "./App.jsx";
    export { default as translations } from "./translations.js";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `);
  t = ui.translations.fi;
  h = ui.createElement;
}, 30_000);

const render = (element) => ui.renderToStaticMarkup(element);
const noop = () => {};

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text a screen reader would read: aria-hidden elements are skipped.
const textOf = (html) => decode(
  html.replace(/<(\w+)[^>]*\saria-hidden="true"[^>]*>.*?<\/\1>/g, "").replace(/<[^>]*>/g, ""),
).replace(/\s+/g, " ").trim();

// Opening tags in document order, each knowing whether it sits inside a <label>.
function parseTags(html) {
  const tags = [];
  let labelDepth = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const [, closing, name, rawAttrs] = m;
    const tag = name.toLowerCase();
    if (closing) {
      if (tag === "label") labelDepth--;
      continue;
    }
    const attrs = Object.fromEntries(
      [...rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, decode(v ?? "")]),
    );
    tags.push({ tag, attrs, label: labelDepth > 0 ? tags.findLast((x) => x.tag === "label") : null, end: m.index + m[0].length });
    if (tag === "label") labelDepth++;
  }
  const ids = tags.map((x) => x.attrs.id).filter(Boolean);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate id "${duplicate}"`);
  return tags;
}

// The markup inside an element, up to its matching closing tag.
function innerHtml(html, el) {
  const re = new RegExp(`<(/?)${el.tag}\\b[^>]*>`, "g");
  re.lastIndex = el.end;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(el.end, m.index);
  }
  return html.slice(el.end);
}

// The accessible name of each input/textarea/select, or null when it has none.
function fieldNames(html) {
  const tags = parseTags(html);
  const textById = (id) => {
    const el = tags.find((x) => x.attrs.id === id);
    return el ? textOf(innerHtml(html, el)) : null;
  };
  return tags
    .filter((x) => /^(input|textarea|select)$/.test(x.tag) && x.attrs.type !== "hidden")
    .map(({ attrs, label: wrapping }) => {
      if (attrs["aria-labelledby"]) {
        const parts = attrs["aria-labelledby"].split(/\s+/).map(textById);
        return parts.every(Boolean) ? parts.join(" ") : null;
      }
      if (attrs["aria-label"]?.trim()) return attrs["aria-label"].trim();
      if (attrs.id) {
        const label = tags.find((x) => x.tag === "label" && x.attrs.for === attrs.id);
        if (label) return textOf(innerHtml(html, label)) || null;
      }
      if (wrapping) return textOf(innerHtml(html, wrapping)) || null;
      return null;
    });
}

describe("form fields have accessible names", () => {
  test("the parser sees through placeholders", () => {
    expect(fieldNames('<input placeholder="Nimi"/>')).toEqual([null]);
    expect(fieldNames('<label>Nimi</label><input/>')).toEqual([null]);
    expect(fieldNames('<label for="a">Nimi</label><input id="a"/>')).toEqual(["Nimi"]);
    expect(fieldNames('<label><input type="checkbox"/> Nimi</label>')).toEqual(["Nimi"]);
    expect(fieldNames('<label><input type="checkbox"/></label>')).toEqual([null]);
    expect(fieldNames('<label for="a">Nimi<span aria-hidden="true"> *</span></label><input id="a"/>')).toEqual(["Nimi"]);
    expect(fieldNames('<div id="q"><div>Väite</div> yksi</div><textarea aria-labelledby="q"></textarea>')).toEqual(["Väite yksi"]);
    expect(() => fieldNames('<label for="a">A</label><input id="a"/><input id="a"/>')).toThrow(/duplicate id/);
  });

  test("candidate profile fields are linked to their visible labels", () => {
    const html = render(h(ui.ProfileFields, {
      profile: { name: "", email: "", constituency: "", photoUrl: "", bio: "" },
      setField: noop,
    }));
    expect(fieldNames(html)).toEqual([
      t.candidateFullName,
      t.candidateEmailLabel,
      t.candidateConstituencyLabel,
      t.candidatePhotoUrl,
      t.candidateBio,
    ]);
    // The asterisk is visual only; required fields say so with aria-required.
    const required = parseTags(html).filter((x) => /^(input|textarea|select)$/.test(x.tag)).map((x) => x.attrs["aria-required"] === "true");
    expect(required).toEqual([true, true, true, false, false]);
  });

  test("the candidate's explanation textarea is named after its question", () => {
    const html = render(h(ui.AnswerCard, {
      question: { id: "q1", statement: "Verotusta tulee keventää" },
      number: 3,
      answer: undefined,
      setAnswer: noop,
    }));
    const [name] = fieldNames(html);
    expect(name).toContain("Verotusta tulee keventää");
  });

  test("NGO submission form fields are linked to their labels", () => {
    const names = fieldNames(render(h(ui.NgoView)));
    expect(names.slice(0, 4)).toEqual([t.ngoOrgName, t.ngoContactEmail, t.ngoLogoUrl, t.ngoSetTitle]);
    // Each statement textarea is named, and they're told apart by number.
    expect(names[4]).toBe(t.ngoStatementLabel(1));
    expect(names).toHaveLength(5);
  });

  test("voter constituency filter is linked to its label", () => {
    const html = render(h(ui.ConstituencyFilter, { value: "", onChange: noop }));
    expect(fieldNames(html)).toEqual([t.voterConstituencyLabel]);
  });

  // Only the admin login renders here: the admin panel needs a session and data.
  test("home page link field, admin login and language selector are named", () => {
    for (const element of [
      h(ui.HomeView, { navigate: noop, openLink: noop }),
      h(ui.AdminView),
      h(ui.Header, { view: "home", navigate: noop }),
    ]) {
      const names = fieldNames(render(element));
      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain(null);
    }
  });

  test("the home page link field is described by the text above it", () => {
    const html = render(h(ui.HomeView, { navigate: noop, openLink: noop }));
    const input = parseTags(html).find((x) => x.tag === "input");
    const desc = parseTags(html).find((x) => x.attrs.id === input.attrs["aria-describedby"]);
    expect(textOf(innerHtml(html, desc))).toBe(t.homeCandidateDesc);
  });

  test("a copyable link field is named, with or without a label", () => {
    const value = "https://example.fi/?register=x";
    expect(fieldNames(render(h(ui.CopyField, { value, label: "Rekisteröitymislinkki" })))).toEqual(["Rekisteröitymislinkki"]);
    expect(fieldNames(render(h(ui.CopyField, { value })))).toEqual([t.copyFieldLabel]);
  });
});
