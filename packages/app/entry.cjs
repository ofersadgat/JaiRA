/**
 * The Electron main entry — three lines, and a separate FILE on purpose.
 *
 * `build.mjs` has always emitted `sourcemap: true`, so `dist/main.cjs.map` sat on disk beside the
 * bundle the whole time. A map nobody consults is a map nobody has: Node applies one only when source
 * maps are enabled, and Electron does not enable them on its own. Every stack the app produced
 * therefore pointed into six megabytes of generated output — `main.cjs:38:15` for a throw whose real
 * home is a dependency, with the frames that led there flattened past recognition.
 *
 * The fix cannot live inside the bundle. `process.setSourceMapsEnabled(true)` registers the map for
 * modules compiled AFTER the call, and a bundle is one module that finished compiling before its
 * first line ran — so the same call at the top of `src/main/index.ts` cannot map its own frames, and
 * measurably does not. It has to happen in a module that loads first, which is what this file is.
 *
 * `require` rather than `import` for the same reason: a static `import` is hoisted above the
 * statement, which would put the flag back after the compile it is meant to precede.
 */
process.setSourceMapsEnabled(true);

require("./dist/main.cjs");
