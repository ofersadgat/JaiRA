import type { ComponentType } from "react";
import { Markdown as DomMarkdown } from "@jaira/ui/markdown";
import { Markdown } from "@jaira/universal";

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

export const SPECIMENS: Record<string, Specimen> = {
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
