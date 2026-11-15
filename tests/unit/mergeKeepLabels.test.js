const fs = require("fs");
const { loadFrontend } = require("../helpers/frontendBundle");

const questions = [
  { id: "q1", statement: "Verotusta tulee keventää" },
  { id: "q2", statement: "Koulutukseen tulee panostaa" },
];

let ui;
beforeAll(async () => {
  ui = await loadFrontend(`
    export { AdminView, LanguageContext } from "./App.jsx";
    export { default as translations } from "./translations.js";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `, [{
    name: "selected-admin-merge-questions",
    setup(build) {
      build.onLoad({ filter: /\/App\.jsx$/ }, async ({ path }) => {
        let source = await fs.promises.readFile(path, "utf8");
        // Server rendering cannot log in or select rows. Seed those states
        // while preserving the real AdminView markup and translations.
        const states = [
          ["const [authed, setAuthed] = useState(false);", "true"],
          ["const [questionSets, setQuestionSets] = useState([]);", JSON.stringify([
            { id: "set1", title: "Kysymykset", status: "approved", questions },
          ])],
          ["const [mergeSelection, setMergeSelection] = useState([]);", JSON.stringify(questions.map(q => q.id))],
        ];
        for (const [initializer, value] of states) {
          if (!source.includes(initializer)) throw new Error(`State initializer not found: ${initializer}`);
          source = source.replace(initializer, initializer.replace(/useState\(.*\)/, `useState(${value})`));
        }
        return { contents: source + "\nexport { LanguageContext };", loader: "jsx" };
      });
    },
  }]);
}, 30_000);

test.each(["fi", "en"])("merge keep radios identify their question in %s (#61)", (lang) => {
  const h = ui.createElement;
  const t = ui.translations[lang];
  const html = ui.renderToStaticMarkup(h(ui.LanguageContext.Provider, {
    value: { lang, t, setLang: () => {} },
  }, h(ui.AdminView)));
  const radios = [...html.matchAll(/<input\b[^>]*name="merge-keep"[^>]*>/g)].map(m => m[0]);
  expect(radios).toHaveLength(questions.length);
  questions.forEach((q, i) => {
    expect(radios[i]).toContain(`aria-label="${t.adminMergeKeepLabel}: ${q.statement}"`);
  });
});
