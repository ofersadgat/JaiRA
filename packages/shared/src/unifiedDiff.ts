/**
 * A unified diff, read as the description of a change that it is.
 *
 * `changeset.ts` models a change as a VALUE: two full texts, hunks derived from them, and a merge
 * that writes `after` to the path. That is the right model for something a person approves, and it
 * is the wrong model for this. A patch carries neither side of the file — only hunks, each with a
 * few lines of context — so producing a {@link Change} from one would mean FABRICATING `before` and
 * `after` from the fragments, and `after` is what gets written to disk on merge. A synthesized one
 * would truncate the file to its hunks.
 *
 * So this parses to a shape that is deliberately, structurally unable to be applied. There is no
 * content here, only lines and the numbers the patch itself gives them; nothing downstream can
 * mistake it for a proposal. It is a READING, in the same sense `structured.ts` is a reading — and
 * the presentation it feeds reuses the changeset viewer's vocabulary without reusing its model.
 *
 * ## What it does not do
 *
 * No dialect beyond the one git and `diff -u` emit. Context diffs (`***`), normal diffs (`3c3`) and
 * combined merge diffs (`@@@`) are not recognised and come back as nothing, which is the correct
 * answer: the caller falls back to showing the source, and a parser that guessed at a format it does
 * not know would mislabel additions as deletions somewhere and be believed.
 */

/** One line inside a hunk, with the numbers the patch assigns it. */
export interface PatchLine {
  kind: "context" | "add" | "del";
  /** The text without its `+`/`-`/space marker. */
  text: string;
  /** Its line number on the left, for a context or removed line. */
  oldLine?: number;
  /** Its line number on the right, for a context or added line. */
  newLine?: number;
  /** `\ No newline at end of file` applied to this line. */
  noNewline?: boolean;
}

/** One `@@` region. */
export interface PatchHunk {
  /** The header exactly as written, for showing above the region. */
  header: string;
  /** Whatever git put after the second `@@` — usually the enclosing function. */
  section?: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export type PatchAction = "create" | "delete" | "update" | "rename";

/** One file's worth of a patch. */
export interface PatchFile {
  /** The path after the change — `/dev/null` is never used as one; see {@link parseUnifiedDiff}. */
  path: string;
  /** Where a rename came from. */
  fromPath?: string;
  action: PatchAction;
  hunks: PatchHunk[];
  /** Why there are no hunks, when the patch says the content cannot be shown. */
  binary?: string;
  added: number;
  removed: number;
}

/**
 * The mark that says "this is a patch", and the only one worth sniffing on.
 *
 * `@@ -1,4 +1,5 @@` is about as unambiguous as a document mark gets — nothing else in ordinary prose
 * or source produces it — which is why this is allowed to be a sniffer at all, where YAML is not (see
 * `valueViews.ts`). The `diff --git` line is deliberately NOT enough on its own: a patch with a
 * header and no hunks is a mode change or a pure rename, and those are worth showing, but a line of
 * prose beginning "diff --git" is not a document.
 */
const HUNK_MARK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/** Whether a string reads as a unified diff. */
export function looksLikeUnifiedDiff(text: string): boolean {
  return HUNK_MARK.test(text);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Strip git's `a/` and `b/` prefixes. `/dev/null` comes back empty — it is not a path. */
function pathOf(raw: string): string {
  const trimmed = raw.trim().replace(/\t.*$/, "");
  if (trimmed === "/dev/null") return "";
  return trimmed.replace(/^[ab]\//, "");
}

/**
 * Every file a patch touches, in the order the patch names them.
 *
 * Empty for anything that is not a unified diff — including text that merely mentions one. A caller
 * treats that as "no reading", never as "a patch that changes nothing".
 *
 * The parse is a single pass over the lines with one piece of state (the open file, and the open
 * hunk under it), which is all the format needs: every line is classified by its first character,
 * and the only lookahead is the hunk header's own counts.
 */
export function parseUnifiedDiff(text: string): PatchFile[] {
  // Nothing that is not a unified diff gets past here, and the gate is what makes "empty" mean "not
  // this format" rather than "a patch that changes nothing". Without it a context diff's `--- b.txt`
  // opened a file and the parse reported a change to it — the exact mislabelling the module header
  // says this must not do. `diff --git` is admitted alongside the hunk mark because a rename or a
  // binary change is a real patch with no hunks in it.
  if (!looksLikeUnifiedDiff(text) && !/^diff --git /m.test(text)) return [];

  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  /** Line numbers as the hunk walks its body — see the header's `-oldStart` / `+newStart`. */
  let oldLine = 0;
  let newLine = 0;
  /**
   * How many lines of each side the open hunk still owes, from its own header.
   *
   * The hunk's LENGTH is what ends it, not the look of the next line. Reading "anything that is not
   * a `+`/`-`/space ends the hunk" is nearly right and fails on the most ordinary input there is:
   * every patch ends with a newline, `split` turns that into a final empty string, and an empty
   * string is a legitimate way to write a blank context line — so the last hunk of every file
   * silently grew a phantom line that was not in the patch.
   */
  let owedOld = 0;
  let owedNew = 0;

  /**
   * Start a file, or reuse the one a `---`/`+++` pair is describing after a `diff --git`.
   *
   * RETURNS the file and never assigns `file` itself, and that is a typing decision rather than a
   * stylistic one: TypeScript does not narrow a variable a closure assigns, so with the assignment
   * in here every later read of `file` is typed `never` and every use needs a `!` — the assertion
   * being exactly what a parser reading half-formed input should not be reaching for. Callers
   * assign, so the narrowing is real.
   */
  const open = (path: string): PatchFile => {
    if (file !== null && file.hunks.length === 0 && file.binary === undefined && file.path === "") {
      file.path = path;
      return file;
    }
    const next: PatchFile = { path, action: "update", hunks: [], added: 0, removed: 0 };
    files.push(next);
    return next;
  };

  const lines = text.split("\n");
  // The final newline TERMINATES the last line rather than starting an empty one. Belt as well as
  // braces alongside the hunk counts above: a patch whose header overstates its body — which a model
  // writing one by hand routinely produces — would otherwise spend the leftover budget on this and
  // show a blank line the patch does not contain.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");

    // --- inside a hunk body ---
    if (hunk !== null && owedOld <= 0 && owedNew <= 0) hunk = null;
    if (hunk !== null) {
      const marker = line[0];
      // `\ No newline at end of file` annotates the line before it rather than being one, and owes
      // neither side a line.
      if (line.startsWith("\\")) {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last !== undefined) last.noNewline = true;
        continue;
      }
      // A truly empty line is a context line whose content is empty: plenty of tools drop the
      // leading space rather than emitting a line with nothing but it. Safe to read that way only
      // because the hunk's own counts decide when it ends — see {@link owedOld}.
      if (marker === " " || line === "") {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        owedOld--;
        owedNew--;
        continue;
      }
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1), newLine: newLine++ });
        file!.added++;
        owedNew--;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldLine++ });
        file!.removed++;
        owedOld--;
        continue;
      }
      // A hunk whose counts overstate its body — a truncated paste — still ends here rather than
      // eating the rest of the patch.
      hunk = null;
    }

    if (line.startsWith("diff --git ")) {
      // The paths on this line are quoted and escaped when they need to be, so the `---`/`+++` pair
      // below is the better source; this only opens the file so a header-only entry (a mode change,
      // a pure rename) still appears.
      const pair = /^diff --git (.+) (.+)$/.exec(line);
      const opened = open(pair === null ? "" : pathOf(pair[2]!));
      if (pair !== null) opened.fromPath = pathOf(pair[1]!) || undefined;
      file = opened;
      hunk = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const from = pathOf(line.slice(4));
      // `open` returns the file it opened rather than only assigning `file`, because assignment
      // inside a closure does not narrow: every read after `if (file === null) open(...)` would be
      // typed `never`, and the `!` needed to silence that is exactly the assertion this avoids.
      const at: PatchFile = file ?? open("");
      file = at;
      if (from === "") at.action = "create";
      else if (at.path === "") at.path = from;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const to = pathOf(line.slice(4));
      const at: PatchFile = file ?? open(to);
      file = at;
      if (to === "") at.action = "delete";
      else at.path = to;
      continue;
    }
    if (line.startsWith("rename from ") && file !== null) {
      file.fromPath = pathOf(line.slice("rename from ".length));
      file.action = "rename";
      continue;
    }
    if (line.startsWith("rename to ") && file !== null) {
      file.path = pathOf(line.slice("rename to ".length));
      file.action = "rename";
      continue;
    }
    if (line.startsWith("new file mode") && file !== null) {
      file.action = "create";
      continue;
    }
    if (line.startsWith("deleted file mode") && file !== null) {
      file.action = "delete";
      continue;
    }
    if ((line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) && file !== null) {
      file.binary = "binary — the patch carries no readable content";
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      // A patch with no file header at all — a bare hunk, which is what a fence usually holds.
      const at: PatchFile = file ?? open("");
      file = at;
      const section = header[5]!.trim();
      hunk = {
        header: line.slice(0, line.lastIndexOf("@@") + 2),
        ...(section === "" ? {} : { section }),
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      owedOld = hunk.oldCount;
      owedNew = hunk.newCount;
      at.hunks.push(hunk);
      continue;
    }
    // `index abc..def`, `old mode`, git's trailing `-- \n2.43.0`, and any prose around the patch.
    // Ignored rather than collected: the reading is the change, not the envelope it travelled in.
  }

  // A `diff --git` that never resolved a path is an entry about nothing — usually the tail of a
  // truncated paste. Dropped rather than drawn as a file called "".
  return files.filter((entry) => entry.path !== "" || entry.hunks.length > 0);
}

/** What the whole patch adds and removes — the count on its heading. */
export function patchStats(files: readonly PatchFile[]): { added: number; removed: number } {
  return files.reduce(
    (total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
    { added: 0, removed: 0 },
  );
}
