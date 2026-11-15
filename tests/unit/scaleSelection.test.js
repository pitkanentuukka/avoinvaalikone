const { loadFrontend } = require("../helpers/frontendBundle");

let ui;
beforeAll(async () => {
  ui = await loadFrontend(`
    export { AnswerCard } from "./App.jsx";
    export { renderToStaticMarkup } from "react-dom/server";
    export { createElement } from "react";
  `);
}, 30_000);

test.each([undefined, 0, 1, 2, 3, 4])(
  "scale exposes the selected position to screen readers (value %s, #103)",
  (value) => {
    const html = ui.renderToStaticMarkup(ui.createElement(ui.AnswerCard, {
      question: { id: "q1", statement: "Testiväittämä" },
      number: 1,
      answer: value === undefined ? undefined : { value, text: "" },
      setAnswer: () => {},
    }));
    const buttons = [...html.matchAll(/<button\b([^>]*)>/g)];
    expect(buttons).toHaveLength(5);
    buttons.forEach(([, attrs], i) => {
      expect(attrs).toContain(`aria-pressed="${value === i}"`);
    });
  },
);
