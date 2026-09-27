/**
 * fast-flow-transform's API, on Babel.
 *
 * The real package is a Rust addon, and its win32-x64 build panics with "Location from Hermes parser
 * cannot be found" on every input, even `// @flow\nexport type A = number;` (measured 2026-09-27 on
 * 0.0.3, the latest). A Rust panic aborts the process, so One's callers cannot catch it: the web build
 * dies patching `@react-native-masked-view`, and Metro dies on React Native's own sources.
 *
 * Same parser (Hermes, which reads every Flow syntax React Native uses), same job (strip the types),
 * same answer shape (`{ code, map }`). Slower, which only the first patch pass and a cold Metro notice.
 */
const babel = require("@babel/core");

module.exports = async function fastFlowTransform(options) {
  const { filename = "file.js", source, sourcemap = false } = options;
  const result = await babel.transformAsync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: sourcemap,
    compact: false,
    retainLines: false,
    plugins: [
      require.resolve("babel-plugin-syntax-hermes-parser"),
      [require.resolve("@babel/plugin-transform-flow-strip-types"), { requireDirective: false }],
    ],
  });
  return { code: result?.code ?? source, map: result?.map ?? null };
};
module.exports.default = module.exports;
