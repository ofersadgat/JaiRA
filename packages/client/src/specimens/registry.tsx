import type { ComponentType } from "react";
import { Markdown as DomMarkdown } from "@jaira/ui/markdown";
import type { FileSource } from "@jaira/shared/browser";
import { FileInspector as DomFileInspector } from "@jaira/ui/files";
import { DataView as DomDataView } from "@jaira/ui/valueView";
import { DataView, FileInspector, Markdown } from "@jaira/universal";

/**
 * The specimens: a DOM component and its universal copy, each drawn from the same fixture, for
 * `pair.mts --specimen <name>` (decision 0015). Browser-only — imported from the `.web` specimen routes.
 */
export interface Specimen {
  /** The box it is drawn in, in CSS pixels, as the component's usual column is wide. */
  width: number;
  dom: ComponentType;
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
  // `valueView.tsx`'s data tree — the Files viewer of a JSON or YAML file (decision 0015).
  "data-view": {
    width: 520,
    dom: () => <DomDataView value={DATA} />,
    rn: () => <DataView value={DATA} />,
  },
  // The ⓘ popover's contents on the Files address (`.facts-pop`: 320 wide, padding 12 — the box here).
  "file-facts": {
    width: 296,
    dom: () => <DomFileInspector doc={FILE} />,
    rn: () => <FileInspector doc={FILE} />,
  },
  markdown: {
    width: 520,
    dom: () => (
      <div className="markdown-host">
        <DomMarkdown text={PROSE} />
      </div>
    ),
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
