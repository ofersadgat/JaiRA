/**
 * Hand-written types for Monaco's diff computer (CHANGESETS.md §7.3).
 *
 * The ESM tree ships no `.d.ts` beside its internals — `monaco.d.ts` covers only the public editor
 * API — so the deep import is typed here, narrowly: exactly the fields the text strategy reads,
 * nothing speculative. The module path is an UNVERSIONED internal surface; the tripwire is the
 * "the exact differ Monaco renders with" test in `test/diffStrategies.test.ts`, which fails on any
 * upgrade that moves or reshapes it — that failure is the signal to update this file and the
 * import, not to pin the package.
 */
declare module "monaco-editor/editor/common/diff/linesDiffComputers.js" {
  /** `[startLineNumber, endLineNumberExclusive)`, 1-based — monaco's LineRange. */
  export interface DiffLineRange {
    readonly startLineNumber: number;
    readonly endLineNumberExclusive: number;
  }

  export interface DetailedLineRangeMapping {
    readonly original: DiffLineRange;
    readonly modified: DiffLineRange;
  }

  export interface LinesDiff {
    readonly changes: readonly DetailedLineRangeMapping[];
    readonly hitTimeout: boolean;
  }

  export interface LinesDiffComputer {
    computeDiff(
      originalLines: readonly string[],
      modifiedLines: readonly string[],
      options: { ignoreTrimWhitespace: boolean; computeMoves: boolean; maxComputationTimeMs: number },
    ): LinesDiff;
  }

  export const linesDiffComputers: {
    /** The 'advanced' algorithm — what the DiffEditor uses by default. */
    getDefault(): LinesDiffComputer;
    getLegacy(): LinesDiffComputer;
  };
}
