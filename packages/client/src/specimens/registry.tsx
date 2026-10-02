import type { ComponentType } from "react";
import type { FileSource } from "@jaira/shared/browser";
import { DataView, FileInspector, Markdown } from "@jaira/universal";
import { ARTIFACT_SPECIMENS } from "./artifactSpecimens";
import { DRAG_SPECIMENS } from "./dragSpecimens";
import { ENVIRONMENT_SPECIMENS } from "./environmentSpecimens";
import { FLOAT_SPECIMENS } from "./floatSpecimens";
import { FORM_SPECIMENS } from "./formSpecimens";
import { FORMS_FILES_SPECIMENS } from "./formsFilesSpecimens";
import { MESSAGE_SOURCE_SPECIMENS } from "./messageSourceSpecimens";
import { SHELL_SPECIMENS } from "./shellSpecimens";
import { REVIEW_SPECIMENS } from "./reviewSpecimens";
import { CHANGESET_SPECIMENS } from "./changesetSpecimens";
import { ROOM_SPECIMENS } from "./roomSpecimens";
import { RAIL_SPECIMENS } from "./railSpecimens";
import { TRANSCRIPT_SPECIMENS } from "./transcriptSpecimens";
import { VALUE_SPECIMENS } from "./valueSpecimens";

/**
 * The specimens: a component drawn alone from a fixture, for `pair.mts --specimen <name>`, which holds
 * its picture against the reference picture of the same name (decision 0015). The reference pictures
 * are of the DOM renderer drawing the same fixtures (the tag `dom-renderer-final` has that half of each
 * specimen). Browser-only — imported from the `.web` specimen route.
 */
export interface Specimen {
  /** The box it is drawn in, in CSS pixels, as the component's usual column is wide. */
  width: number;
  rn: ComponentType;
}

const PROSE = [
  "# Review notes",
  "",
  "The critique found **three** weaknesses, one *minor*. See `feature/plan/critique` for the full report, or [the docs](https://example.com/docs).",
  "",
  "## What to change",
  "",
  "- The sync lint ignores renames",
  "- No test for an empty board",
  "  - nor for a board of one",
  "- ~~Nothing else~~ one more thing",
  "",
  "1. Write the test",
  "2. Fix the lint",
  "",
  "> A plan that survives contact is a plan that was tested.",
  "",
  "| Weakness | Severity |",
  "| --- | --- |",
  "| The sync lint ignores renames | high |",
  "| No test for an empty board | medium |",
  "",
  "```ts",
  "export function laneOf(card: BoardCard): Lane {",
  '  return card.endedAt !== undefined ? "finished" : "running";',
  "}",
  "```",
  "",
  "---",
  "",
  "### Last words",
  "",
  "A line with a hard break  ",
  "and its continuation.",
].join("\n");

/** A parsed document with every kind of leaf the data tree draws, nested two deep. */
const DATA = {
  name: "feature/plan",
  version: 3,
  strict: true,
  owner: null,
  steps: ["draft", "critique", { id: "human_review", timeout: 3600, notes: "a longer value, to see where the line goes when it is wider than a key" }],
  empty: {},
  none: [],
};

/** The facts behind the Files address's ⓘ: a plain file. */
const FILE: FileSource = {
  layer: "project",
  path: "prompts/plan/draft.md",
  file: "/home/me/work/checkout/.jaira/prompts/plan/draft.md",
  mime: "text/markdown",
  text: ["# Draft", "", "Write the plan.", ""].join("\n"),
  exists: true,
};

export const SPECIMENS: Record<string, Specimen> = {
  // The schema form's field kinds (`formSpecimens.tsx`): a run's or a gate's form, and Settings rows.
  ...FORM_SPECIMENS,
  // The shell's floats and dialogs, and every stage of the Components room (`floatSpecimens.tsx`).
  ...FLOAT_SPECIMENS,
  // The transcript's pieces: work rows, pauses, compactions and the work summary (`transcriptSpecimens.tsx`).
  ...TRANSCRIPT_SPECIMENS,
  // The badge on a message the person did not type, over a bubble and beside an aside's role (`messageSourceSpecimens.tsx`).
  ...MESSAGE_SOURCE_SPECIMENS,
  // The value view's readings: JSON with its schema's hints, a form, a patch, a table, pictures, code (`valueSpecimens.tsx`).
  ...VALUE_SPECIMENS,
  // What the window says about itself (the toast, the crash screen and banner, a lost socket), settled
  // gates, and a conversation's foot (`shellSpecimens.tsx`).
  ...SHELL_SPECIMENS,
  // A review's notes, one from the forge (`reviewSpecimens.tsx`).
  ...REVIEW_SPECIMENS,
  // The changeset reviewer settled, on a picture, and its picture comparison (`changesetSpecimens.tsx`).
  ...CHANGESET_SPECIMENS,
  // A card's origin line and Undo, the Debug journal, and Files surfaces (`roomSpecimens.tsx`).
  ...ROOM_SPECIMENS,
  // The rail in the shapes the world never draws: a stacked column, a rolled-up lane (`railSpecimens.tsx`).
  ...RAIL_SPECIMENS,
  // The boards with a drag held part-way: the drop targets, the preview, the move's question (`dragSpecimens.tsx`).
  ...DRAG_SPECIMENS,
  // A value owning the panel's column, a page in it full bleed (`artifactSpecimens.tsx`).
  ...ARTIFACT_SPECIMENS,
  // A box's `<datalist>` type-ahead, the Files room's last surfaces and the Debug session panel (`formsFilesSpecimens.tsx`).
  ...FORMS_FILES_SPECIMENS,
  // Where a conversation runs: a machine's icon, the bar under the composer, its list, and how it was placed (`environmentSpecimens.tsx`).
  ...ENVIRONMENT_SPECIMENS,
  // The data tree — the Files viewer of a JSON or YAML file (decision 0015).
  "data-view": {
    width: 520,
    rn: () => <DataView value={DATA} />,
  },
  // The ⓘ popover's contents on the Files address (the popover is 320 wide, padding 12 — the box here).
  "file-facts": {
    width: 296,
    rn: () => <FileInspector doc={FILE} />,
  },
  markdown: {
    width: 520,
    rn: () => <Markdown text={PROSE} />,
  },
};

export function specimenOf(name: string | null): Specimen | undefined {
  return name === null ? undefined : SPECIMENS[name];
}

/** `light`, `dark`, or `<palette>[-wash]-<theme>`, as the shots name looks. */
export function lookOf(name: string | null): { palette: string; scheme: "light" | "dark"; wash: boolean } {
  if (name === null || name === "light" || name === "dark") return { palette: "ink", scheme: name === "dark" ? "dark" : "light", wash: false };
  const m = /^([a-z-]+?)(-wash)?-(light|dark)$/.exec(name);
  return m === null ? { palette: "ink", scheme: "light", wash: false } : { palette: m[1]!, scheme: m[3] as "light" | "dark", wash: m[2] !== undefined };
}
