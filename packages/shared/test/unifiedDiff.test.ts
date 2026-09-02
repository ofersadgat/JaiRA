/**
 * Reading a patch.
 *
 * The properties worth defending are about what the reading REFUSES to invent. A patch is a
 * description of a change and not the change itself — it carries no file content — so the parse must
 * keep the patch's own line numbers (a reader looking for line 412 needs to see 412, not 7), must
 * leave the gaps between hunks as gaps, and must come back empty for a format it does not know
 * rather than mislabelling one. See `unifiedDiff.ts` on why a `Change` is the wrong target.
 */
import { describe, expect, it } from "vitest";
import { looksLikeUnifiedDiff, parseUnifiedDiff, patchStats } from "../src/unifiedDiff";

const GIT_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ export function boot() {",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
  " }",
  "",
].join("\n");

describe("what it recognises", () => {
  it("finds a patch by its hunk mark and nothing weaker", () => {
    expect(looksLikeUnifiedDiff(GIT_PATCH)).toBe(true);
    expect(looksLikeUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n")).toBe(true);
    // A header with no hunks is not enough to call a body of text a patch.
    expect(looksLikeUnifiedDiff("diff --git a/x b/x\n")).toBe(false);
    expect(looksLikeUnifiedDiff("we should diff --git the two files")).toBe(false);
  });

  it("comes back empty for a dialect it does not know", () => {
    // A normal diff and a context diff. Answering nothing sends the caller to the source, which is
    // the honest outcome — a guess here would label an addition as a removal and be believed.
    expect(parseUnifiedDiff("3c3\n< old\n---\n> new\n")).toEqual([]);
    expect(parseUnifiedDiff("*** a.txt\n--- b.txt\n***************\n! changed\n")).toEqual([]);
    expect(parseUnifiedDiff("just some prose")).toEqual([]);
  });
});

describe("the numbers the patch gives", () => {
  it("keeps the file's own line numbers rather than counting from one", () => {
    // The reason this is not fed through the changeset viewer: Monaco would number the synthesized
    // text from 1, and a reader looking for line 12 would be shown line 3.
    const [file] = parseUnifiedDiff(GIT_PATCH);
    const hunk = file!.hunks[0]!;
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    expect(hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 10, 10],
      ["del", 11, undefined],
      ["add", undefined, 11],
      ["add", undefined, 12],
      ["context", 12, 13],
      ["context", 13, 14],
    ]);
  });

  it("counts what changed, per file and in total", () => {
    const files = parseUnifiedDiff(GIT_PATCH);
    expect(files[0]).toMatchObject({ path: "src/app.ts", action: "update", added: 2, removed: 1 });
    expect(patchStats(files)).toEqual({ added: 2, removed: 1 });
  });

  it("carries the section git names after the second @@", () => {
    const [file] = parseUnifiedDiff(GIT_PATCH);
    expect(file!.hunks[0]!.section).toBe("export function boot() {");
    expect(file!.hunks[0]!.header).toBe("@@ -10,4 +10,5 @@");
  });

  it("reads a one-line hunk, whose counts are omitted", () => {
    const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -7 +7 @@\n-a\n+b\n");
    expect(file!.hunks[0]).toMatchObject({ oldStart: 7, oldCount: 1, newStart: 7, newCount: 1 });
  });
});

describe("what kind of change each file is", () => {
  it("tells create, delete and rename apart from an edit", () => {
    const created = parseUnifiedDiff("diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n");
    expect(created[0]).toMatchObject({ path: "n.txt", action: "create", added: 1, removed: 0 });

    const deleted = parseUnifiedDiff("diff --git a/o.txt b/o.txt\ndeleted file mode 100644\n--- a/o.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n");
    expect(deleted[0]).toMatchObject({ path: "o.txt", action: "delete", removed: 1 });

    const renamed = parseUnifiedDiff("diff --git a/x.ts b/y.ts\nsimilarity index 92%\nrename from x.ts\nrename to y.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(renamed[0]).toMatchObject({ path: "y.ts", fromPath: "x.ts", action: "rename" });
  });

  it("says a binary file cannot be shown instead of showing nothing", () => {
    const files = parseUnifiedDiff("diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n");
    expect(files[0]).toMatchObject({ path: "logo.png", binary: expect.stringContaining("binary") });
    expect(files[0]!.hunks).toEqual([]);
  });

  it("reads several files in one patch", () => {
    const files = parseUnifiedDiff(`${GIT_PATCH}diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "b.ts"]);
    expect(patchStats(files)).toEqual({ added: 3, removed: 2 });
  });
});

describe("the awkward lines", () => {
  it("attaches 'no newline at end of file' to the line it is about", () => {
    const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    const lines = file!.hunks[0]!.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "del", noNewline: true });
  });

  it("reads a blank context line, which plenty of tools write without its leading space", () => {
    const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
    expect(file!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["context", "context", "del", "add"]);
  });

  it("stops a hunk at the next file rather than swallowing its header", () => {
    const files = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n");
    expect(files).toHaveLength(2);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2);
  });

  it("reads a bare hunk with no file header, which is what a fence usually holds", () => {
    const files = parseUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+b\n c\n");
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("");
    expect(files[0]!.added).toBe(1);
  });

  it("does not treat a removed line that begins with a dash as a header", () => {
    // `--- ` inside a hunk body is content, and reading it as a file header would end the hunk and
    // lose every line after it.
    const [file] = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- old marker\n+++ new marker\n");
    expect(file!.hunks[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
      ["del", "-- old marker"],
      ["add", "++ new marker"],
    ]);
  });
});
