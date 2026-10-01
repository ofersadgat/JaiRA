/**
 * A patch, as the patch reading draws it.
 *
 * The parse is tested in `shared/test/unifiedDiff.test.ts`. What is held here is what the reading's two
 * promises stand on, on a patch of TWO hunks — which that file does not have. Both promises exist
 * because this is NOT the changeset viewer: the line numbers on screen are the patch's own — a
 * re-diff of synthesized text would number from 1 and quietly send a reader to the wrong place — and
 * the gap between two hunks is drawn as a boundary rather than closed up, because lines 130 and 400
 * are not neighbours. The reading draws a region per hunk and a number per line straight from the
 * parse, so the parse is where both are decided.
 *
 * The drawing itself — the totals line, a rename's two names, what a binary file says — is the
 * universal tree's, over values the shared test already holds.
 */
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@jaira/shared/browser";

const TWO_HUNKS = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,3 @@ function boot() {",
  " const a = 1;",
  "+const b = 2;",
  " return a;",
  "@@ -400,2 +401,1 @@ function stop() {",
  " const c = 3;",
  "-const d = 4;",
  "",
].join("\n");

describe("a patch of two hunks", () => {
  it("keeps the patch's own line numbers in both hunks, not a count from one", () => {
    const [file] = parseUnifiedDiff(TWO_HUNKS);
    expect(file!.hunks.map((hunk) => hunk.lines.map((line) => [line.oldLine, line.newLine]))).toEqual([
      [
        [10, 10],
        [undefined, 11],
        [11, 12],
      ],
      // The second hunk starts where the patch says it does, on each side.
      [
        [400, 401],
        [401, undefined],
      ],
    ]);
  });

  it("keeps each hunk as its own region, so the gap between them is visible", () => {
    const files = parseUnifiedDiff(TWO_HUNKS);
    expect(files).toHaveLength(1);
    // The section git names after the second `@@` rides along — it is the cheapest possible answer
    // to "where in the file am I".
    expect(files[0]!.hunks.map((hunk) => [hunk.header, hunk.section])).toEqual([
      ["@@ -10,2 +10,3 @@", "function boot() {"],
      ["@@ -400,2 +401,1 @@", "function stop() {"],
    ]);
  });

  it("marks added and removed lines apart from context", () => {
    const [file] = parseUnifiedDiff(TWO_HUNKS);
    // Two context lines around the addition, one before the deletion.
    expect(file!.hunks.map((hunk) => hunk.lines.map((line) => line.kind))).toEqual([
      ["context", "add", "context"],
      ["context", "del"],
    ]);
  });
});

describe("a header with no hunks", () => {
  it("is still a file, with no lines changing — a mode change is not nothing", () => {
    // What the reading says of it ("No lines change — a rename or a mode change.") it says for a file
    // with no hunks that is not binary; a parse that dropped the file would leave it saying nothing.
    const files = parseUnifiedDiff("diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "x.sh", hunks: [], added: 0, removed: 0 });
    expect(files[0]!.binary).toBeUndefined();
  });
});
