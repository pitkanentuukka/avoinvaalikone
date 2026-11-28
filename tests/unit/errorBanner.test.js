// #226: the admin panel passes every failure's message to one ErrorBanner,
// which must show each of them. Rendered with the real React, since the
// admin view tests read only the banner's props.
const fs = require("fs");
const { loadFrontend } = require("../helpers/frontendBundle");

let ui;
beforeAll(async () => {
  ui = await loadFrontend(`
    export { ErrorBanner, LanguageContext } from "./App.jsx";
    export { default as translations } from "./translations.js";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `, [{
    name: "export-error-banner",
    setup(build) {
      build.onLoad({ filter: /\/App\.jsx$/ }, async ({ path }) => ({
        contents: `${await fs.promises.readFile(path, "utf8")}\nexport { ErrorBanner, LanguageContext };`,
        loader: "jsx",
      }));
    },
  }]);
}, 30_000);

function render(props) {
  const h = ui.createElement;
  return ui.renderToStaticMarkup(h(ui.LanguageContext.Provider, {
    value: { lang: "fi", t: ui.translations.fi, setLang: () => {} },
  }, h(ui.ErrorBanner, props)));
}

describe("ErrorBanner", () => {
  test("shows every message, each once, with one retry button", () => {
    const html = render({ messages: ["Poisto epäonnistui", "Vaihto epäonnistui"], onRetry: () => {} });
    expect(html.match(/Poisto epäonnistui/g)).toHaveLength(1);
    expect(html.match(/Vaihto epäonnistui/g)).toHaveLength(1);
    expect(html.indexOf("Poisto")).toBeLessThan(html.indexOf("Vaihto"));
    expect(html.match(new RegExp(ui.translations.fi.retry, "g"))).toHaveLength(1);
  });

  test("a single message still works", () => {
    expect(render({ message: "Lataus epäonnistui" })).toContain("Lataus epäonnistui");
  });
});
