// Vite's ambient module declarations — what types a `?worker` import (monacoDiff.tsx) as a Worker
// constructor. Referenced explicitly because `types: ["node"]` turns off automatic @types
// inclusion, and the root tsconfig deliberately keeps Vite's own config out of the program.
/// <reference types="vite/client" />

/**
 * Monaco's own Monarch definitions, which it ships as data and does not type.
 *
 * `monacoTokens.ts` imports one to widen a single rule — see the note there on why splitting
 * `keyword` is the difference between "the theme's colours" and "the theme". The module resolves
 * through Monaco's `./*` export map and exports `{ conf, language }` as plain objects; the shape is
 * narrowed at the point of use rather than described here, because what this file has to say is only
 * that the specifier exists.
 */
declare module "monaco-editor/languages/definitions/*" {
  export const conf: unknown;
  export const language: unknown;
}
