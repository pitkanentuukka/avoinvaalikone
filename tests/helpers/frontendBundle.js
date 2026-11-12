// Loads frontend modules that Jest can't import directly (JSX, `import.meta.env`,
// Vite's `?raw` imports) by bundling them with the frontend's own esbuild.
// React is bundled in too, so the components and react-dom/server share one copy.
const path = require("path");

const FRONTEND = path.resolve(__dirname, "../../vaalikone-frontend");
const esbuild = require(require.resolve("esbuild", { paths: [FRONTEND] }));

// `import x from "./file.md?raw"` → the file's text.
const rawImports = {
  name: "raw-imports",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
    }));
  },
};

// `source` is an ES module resolved from vaalikone-frontend/src; returns its exports.
async function loadFrontend(source) {
  const { outputFiles } = await esbuild.build({
    stdin: { contents: source, resolveDir: path.join(FRONTEND, "src"), loader: "jsx" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    loader: { ".md": "text" },
    define: { "import.meta.env": "{}" },
    plugins: [rawImports],
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

module.exports = { loadFrontend };
