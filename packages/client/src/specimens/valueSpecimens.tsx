import { useState, type JSX } from "react";
import type { ViewHint, ViewId } from "@jaira/shared/browser";
import { Markdown, ValueView } from "@jaira/universal";

/**
 * The value view's readings as specimens (decision 0015): `ValueView`
 * (`components/panel/ValueView.tsx`), each from a value and a hint.
 *
 *  - `value-json` — a structured value with a schema: coloured, each key's description ghosted at the
 *    end of its line; `value-json-edit` — the same, editable (it keeps the coloured reading).
 *  - `value-form` — the same value as the fields its schema declares, read-only.
 *  - `value-patch` — a ```diff: two files and a rename, hunks, a line with no newline at the end.
 *  - `value-table` — a CSV as rows and columns: a ragged row, a cell past 320 cut with an ellipsis.
 *  - `value-image` — a picture (`media`), smaller than the column, and one wider than it.
 *  - `value-code` — read-only TypeScript (the tokenizer's reading, an island on web); `value-code-edit`
 *    — the same, editable: the editor island, and the ▾ that picks what draws it.
 *  - `value-changes` — a set of file changes (`Files`), collapsed, with how each fared.
 *  - `markdown-images` — markdown's pictures at their own size, up to the column's width.
 */
export interface ValueSpecimen {
  width: number;
  rn: () => JSX.Element;
}

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "What the critique concluded about the plan." },
    threshold: { type: "number", description: "The score below which the plan goes back to the drafter." },
    retry: { type: "boolean" },
    weaknesses: {
      type: "array",
      description: "Each weakness found, most serious first.",
      items: {
        type: "object",
        properties: {
          what: { type: "string", description: "The weakness, in a sentence." },
          severity: { type: "string", enum: ["low", "medium", "high"], description: "How much it matters to the outcome of the plan, from low to high — a long description, cut at eighty characters." },
        },
      },
    },
  },
};

const VALUE = {
  verdict: "revise",
  threshold: 0.7,
  retry: true,
  weaknesses: [
    { what: "The sync lint ignores renames", severity: "high" },
    { what: "No test for an empty board", severity: "medium" },
  ],
};

const PATCH = [
  "diff --git a/src/lane.ts b/src/lane.ts",
  "index 3b18e51..a1f2c3d 100644",
  "--- a/src/lane.ts",
  "+++ b/src/lane.ts",
  "@@ -12,6 +12,7 @@ export function laneOf(card: BoardCard): Lane {",
  "   if (card.archived) return \"archived\";",
  "   if (card.parked) return \"parked\";",
  "-  return card.endedAt !== undefined ? \"finished\" : \"running\";",
  "+  if (card.endedAt === undefined) return \"running\";",
  "+  return card.failed ? \"failed\" : \"finished\";",
  " }",
  " ",
  "@@ -40,3 +41,3 @@",
  " const ORDER = [\"running\", \"finished\"];",
  "-const LIMIT = 10;",
  "+const LIMIT = 12;",
  "\\ No newline at end of file",
  "diff --git a/docs/old.md b/docs/new.md",
  "similarity index 100%",
  "rename from docs/old.md",
  "rename to docs/new.md",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "new file mode 100644",
  "index 0000000..9f2c1e4",
  "Binary files /dev/null and b/assets/logo.png differ",
  "",
].join("\n");

const CSV = [
  "task,state,started,notes",
  "feature/plan,parked,2026-09-21 10:00,waiting at the human review gate",
  "feature/checkout,finished,2026-09-21 09:12,",
  "bug/scrollbars,failed,2026-09-20 17:40,\"a long note that runs past the three hundred and twenty pixels a cell may take, so the table cuts it with an ellipsis\"",
  "chore/deps,running,2026-09-21 10:30,ragged,one field too many",
  "docs/copying,archived,2026-09-19 12:00,done",
].join("\n");

/** A 96 × 64 picture with a transparent 8px margin on two sides, and an 800 × 240 one wider than the column. */
const SMALL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAi0lEQVR42u3RQQ0AIAwAscmZOt6TiAi8wJ/MwJJecgoaIUmSJElfp/JOOtceNQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzQ+0g6Gz1QnaXAAAAABJRU5ErkJggg==";
const WIDE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAyAAAADwCAYAAAD4pgDaAAAGO0lEQVR42u3XQQ0AIAwEwQqrCN6oQw5KsFE0lAev2WQ0XC5yzQKArrMTANrCiALggADggADggADggACAAwKAAwKAAwKAAwKAAwIADggADggADggADggADggAOCAAOCAAOCAAOCAAOCAA4IAA4IAA4IAA4IAA4IAAgAMCgAMCgAMCgAMCgAMCAA4IAA4IAA4IAA4IAA4IADggADggADggADggADggAOCAAOCAAOCAAOCAAOCAAIADAoADAoADAoADAoADAgAOCAAOCAAOCAAOCAAOiCEFwAEBwAEBwAEBwAEBACMKgAMCgAMCgAMCgAMCAA4IAA4IAA4IAA4IAA4IADggADggADggADggADggAOCAAOCAAOCAAOCAAOCAAIADAoADAoADAoADAoADAgAOCAAOCAAOCAAOCAAOCAA4IAA4IAA4IAA4IAA4IADggADggADggADggADggACAAwKAAwKAAwKAAwKAAwIADggADggADggADggADggAOCAAOCAAOCAAOCAAOCBGFAAHBAAHBAAHBAAHBAAcEAAcEAAcEAAcEAAcEABwQABwQABwQABwQABwQADAAQHAAQHAAQHAAQHAAQEABwQABwQABwQABwQABwQAHBAAHBAAHBAAHBAAHBAAcEAAcEAAcEAAcEAAcEAAwAEBwAEBwAEBwAEBwAEBAAcEAAcEAAcEAAcEAAcEABwQABwQABwQABwQABwQAHBAAHBAAHBAAHBAAHBAAMABAcABAcABAcABAcABMaIAOCAAOCAAOCAAOCAA4IAA4IAA4IAA4IAA4IAAgAMCgAMCgAMCgAMCgAMCAA4IAA4IAA4IAA4IAA4IADggADggADggADggADggAOCAAOCAAOCAAOCAAOCAAIADAoADAoADAoADAoADAgAOCAAOCAAOCAAOCAAOCAA4IAA4IAA4IAA4IAA4IADggADggADggADggADggACAAwKAAwKAAwKAAwKAA2JIAXBAAHBAAHBAAHBAAMCIAuCAAOCAAOCAAOCAAIADAoADAsDnA7JzFAB0hSRJLxlRABwQSZIDAoADIklyQADAAZEkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBAAcEAkSQ4IAA6IJMkBAcABkSTJAQHAAZEkOSAAOCCSJAcEABwQSZIDAoADIklyQABwQCRJckAAcEAkSQ4IAA6IJMkBAQAHRJLkgADggEiSHBAAHBBJkhwQABwQSZIDAoADIklyQADAAZEkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBBDCoADIklyQABwQCRJDggAOCCSJAcEAAdEkuSAAOCASJLkgADggEiSHBAAHBBJkgMCAA6IJMkBAcABkSQ5IAA4IJIkOSAAOCCSJAcEAAdEkuSAAIADIklyQABwQCRJDggADogkSQ4IAA6IJMkBAcABkSQ5IADggEiSHBAAHBBJkgMCgAMiSZIDAoADIklyQABwQCRJDggAOCCSJAcEAAdEkuSAAOCASJLkgADggEiSHBAAHBBJkgMCAA6IJMkBAcABkSQ5IAA4IJIkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBAAcEAkSQ4IAA6IJMkBAcABkSTJAQHAAZEkOSAAOCCSJAcEABwQSZIDAoADIklyQABwQCRJckAAcEAkSQ4IAA6IJMkBAQAHRJLkgADggEiSHBAAHBBJkhwQABwQSZIDAoADIklyQADAAZEkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBAAcEAkSQ4IAA6IJMkBAcABkSTJAQHAAZEkOSAAOCCSJBlRABwQSZIDAoADIklyQADAAZEkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBAAcEAkSQ4IAA6IJMkBAcABkSTJAQHAAZEkOSAAOCCSJAcEABwQSZIDAoADIklyQABwQCRJckAAcEAkSQ4IAA6IJMkBAQAHRJLkgADggEiSHBAAHBBJkhwQABwQSZIDAoADIklyQADAAZEkOSAAOCCSJAcEAAdEkiQHBAAHRJLkgADggEiSHBBDCoADIklyQABwQCRJDggAOCCSJAcEAAdEkuSAAOCASJLkgADggEiS/nYBNu2VPtHa9hkAAAAASUVORK5CYII=";

const CODE = [
  "export function laneOf(card: BoardCard): Lane {",
  '  if (card.archived) return "archived";',
  '  return card.endedAt !== undefined ? "finished" : "running";',
  "}",
].join("\n");

/** A set of file changes, as a sync proposes them: an edit, a new file, a removal; two landed, one did not. */
const CHANGES = [
  { path: "src/lane.ts", action: "update", before: CODE, after: CODE.replace("finished", "done") + "\n// done\n", reason: "The lane names the board uses." },
  { path: "docs/lanes.md", action: "create", after: "# Lanes\n\nRunning, parked, done.\n" },
  { path: "src/deep/nested/folder/with/a/long/name/that/runs/past/the/row/old-lane.ts", action: "delete", before: "export {};\n" },
];
const OUTCOMES = { "src/lane.ts": { ok: true }, "docs/lanes.md": { ok: true }, "src/deep/nested/folder/with/a/long/name/that/runs/past/the/row/old-lane.ts": { ok: false, note: "the file changed since" } };

const PICTURES = [
  "A picture at its own size:",
  "",
  `![a small picture](data:image/png;base64,${SMALL_PNG})`,
  "",
  "And one wider than the column, drawn at the column's width:",
  "",
  `![a wide picture](data:image/png;base64,${WIDE_PNG})`,
  "",
  "The end.",
].join("\n");

/** One `ValueView` from the props; `editable` holds its own draft. */
function pair(value: unknown, hint: ViewHint | undefined, opts: { view?: ViewId; editable?: boolean; label?: string; inline?: boolean } = {}): Pick<ValueSpecimen, "rn"> {
  const props = (edit: ((next: string) => void) | undefined) => ({
    ...(hint !== undefined ? { hint } : {}),
    ...(opts.view !== undefined ? { view: opts.view } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.inline === true ? { inline: true } : {}),
    ...(edit !== undefined ? { edit } : {}),
  });
  return {
    rn: function Rn() {
      const [held, setHeld] = useState(value);
      return <ValueView value={held} {...props(opts.editable === true ? setHeld : undefined)} />;
    },
  };
}

export const VALUE_SPECIMENS: Record<string, ValueSpecimen> = {
  "value-json": { width: 520, ...pair(VALUE, { schema: SCHEMA }, { label: "output" }) },
  "value-json-edit": { width: 520, ...pair(VALUE, { schema: SCHEMA }, { editable: true, label: "output" }) },
  "value-form": { width: 520, ...pair(VALUE, { schema: SCHEMA }, { view: "form", label: "output" }) },
  "value-patch": { width: 520, ...pair(PATCH, { mime: "text/x-diff" }, { label: "patch" }) },
  "value-table": { width: 520, ...pair(CSV, { mime: "text/csv" }, { label: "runs.csv" }) },
  "value-image": {
    width: 520,
    rn: () => (
      <>
        <ValueView value={SMALL_PNG} hint={{ mime: "image/png" }} label="small.png" />
        <ValueView value={WIDE_PNG} hint={{ mime: "image/png" }} label="wide.png" />
      </>
    ),
  },
  "value-code": { width: 520, ...pair(CODE, { mime: "text/x-typescript" }, { label: "lane.ts" }) },
  "value-code-edit": { width: 520, ...pair(CODE, { mime: "text/x-typescript" }, { label: "lane.ts", editable: true }) },
  "value-changes": {
    width: 520,
    rn: () => <ValueView value={CHANGES} label="files" outcomes={OUTCOMES} />,
  },
  "markdown-images": {
    width: 520,
    rn: () => <Markdown text={PICTURES} />,
  },
};
