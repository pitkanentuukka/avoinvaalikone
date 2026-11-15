const fs = require("fs");
const { loadFrontend } = require("../helpers/frontendBundle");

let ui;
beforeAll(async () => {
  ui = await loadFrontend(`
    export { CandidateProfile, NgoView, LanguageContext } from "./App.jsx";
    export { default as translations } from "./translations.js";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `, [{
    name: "open-approved-panel",
    setup(build) {
      build.onLoad({ filter: /\/App\.jsx$/ }, async ({ path }) => {
        const source = await fs.promises.readFile(path, "utf8");
        // Server rendering can't click the panel open. Start it open, while
        // rendering the actual component markup and translation context.
        const closed = "const [showApproved, setShowApproved] = useState(false);";
        if (!source.includes(closed)) throw new Error("Approved panel state initializer not found");
        return {
          contents: source.replace(closed, closed.replace("false", "true"))
            + "\nexport { CandidateProfile, LanguageContext };",
          loader: "jsx",
        };
      });
    },
  }]);
}, 30_000);

describe.each([["fi", "Sulje"], ["en", "Close"]])("close button names in %s (#60)", (lang, name) => {
  test.each(["CandidateProfile", "NgoView"])("%s names its icon-only close button", (component) => {
    const h = ui.createElement;
    const html = ui.renderToStaticMarkup(h(ui.LanguageContext.Provider, {
      value: { lang, t: ui.translations[lang], setLang: () => {} },
    }, h(ui[component], { candidate: { name: "Eeva", partyName: "Puolue" }, onClose: () => {} })));
    const closeButtons = [...html.matchAll(/<button\b([^>]*)>×<\/button>/g)];
    expect(closeButtons).toHaveLength(1);
    expect(closeButtons[0][1]).toContain(`aria-label="${name}"`);
  });
});
