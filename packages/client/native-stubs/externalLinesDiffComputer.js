/**
 * Native stand-in for monaco-editor's `externalLinesDiffComputer.js` (decision 0015).
 *
 * The shared package computes diffs with Monaco's pure line-diff algorithm (`vs/editor/common/diff`,
 * VS Code's `common` layer: no DOM, no Node). Its sibling module loads an optional external computer
 * with a runtime-computed `import()`, which Metro refuses to transform at all. Nothing here selects the
 * external computer (`getAdvancedExternal`/`getAdvancedWasm`), so on native it is this, and says so.
 */
export async function getExternalLinesDiffComputer() {
  throw new Error("monaco's external diff computer is not available on native (native-stubs/externalLinesDiffComputer.js)");
}
