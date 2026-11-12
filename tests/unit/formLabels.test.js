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
const textOf = (html) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

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
    tags.push({ tag, attrs, insideLabel: labelDepth > 0, end: m.index + m[0].length });
    if (tag === "label") labelDepth++;
  }
  return tags;
}

// The accessible name of each input/textarea/select, or null when it has none.
function fieldNames(html) {
  const tags = parseTags(html);
  const textById = (id) => {
    const el = tags.find((x) => x.attrs.id === id);
    if (!el) return null;
    const close = html.indexOf(`</${el.tag}>`, el.end);
    return textOf(html.slice(el.end, close));
  };
  return tags
    .filter((x) => /^(input|textarea|select)$/.test(x.tag) && x.attrs.type !== "hidden")
    .map(({ attrs, insideLabel }) => {
      if (attrs["aria-labelledby"]) {
        const parts = attrs["aria-labelledby"].split(/\s+/).map(textById);
        return parts.every(Boolean) ? parts.join(" ") : null;
      }
      if (attrs["aria-label"]?.trim()) return attrs["aria-label"].trim();
      if (attrs.id) {
        const label = tags.find((x) => x.tag === "label" && x.attrs.for === attrs.id);
        if (label) return textOf(html.slice(label.end, html.indexOf("</label>", label.end)));
      }
      if (insideLabel) return "(wrapped in a label)";
      return null;
    });
}

describe("form fields have accessible names", () => {
  test("the parser sees through placeholders", () => {
    expect(fieldNames('<input placeholder="Nimi"/>')).toEqual([null]);
    expect(fieldNames('<label>Nimi</label><input/>')).toEqual([null]);
    expect(fieldNames('<label for="a">Nimi</label><input id="a"/>')).toEqual(["Nimi"]);
    expect(fieldNames('<label><input type="checkbox"/> Nimi</label>')).toEqual(["(wrapped in a label)"]);
    expect(fieldNames('<p id="q">Väite</p><textarea aria-labelledby="q"></textarea>')).toEqual(["Väite"]);
  });

  test("candidate profile fields are linked to their visible labels", () => {
    const html = render(h(ui.ProfileFields, {
      profile: { name: "", email: "", constituency: "", photoUrl: "", bio: "" },
      setField: noop,
    }));
    expect(fieldNames(html)).toEqual([
      `${t.candidateFullName} *`,
      `${t.candidateEmailLabel} *`,
      `${t.candidateConstituencyLabel} *`,
      t.candidatePhotoUrl,
      t.candidateBio,
    ]);
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
    expect(names[4]).toContain("1");
    expect(names).toHaveLength(5);
  });

  test("voter constituency filter is linked to its label", () => {
    const html = render(h(ui.ConstituencyFilter, { value: "", onChange: noop }));
    expect(fieldNames(html)).toEqual([t.voterConstituencyLabel]);
  });

  test("home page link field, admin password and language selector are named", () => {
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

  test("a copyable link field is named", () => {
    const names = fieldNames(render(h(ui.CopyField, { value: "https://example.fi/?register=x", label: "Rekisteröitymislinkki" })));
    expect(names).toEqual(["Rekisteröitymislinkki"]);
  });
});
