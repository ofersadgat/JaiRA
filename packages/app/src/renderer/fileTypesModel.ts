/**
 * The File types screen's logic, apart from its drawing (decision 0015): `fileTypesPane.tsx` draws it
 * in the DOM and the universal copy natively, and both ask these — what a family's types agree on,
 * what one gesture writes, which palette a view is in, and what each type is shown holding.
 *
 * A factory over a surface registry, because the two shells register the same table with their own
 * components (`fileSurfaceTable.ts`): everything read here (ids, labels, `writes`, `themed`, `look`)
 * is the table's and so the same in both, and the preview draws the shell's own `surface`.
 */
import {
  PANE_TYPES,
  paneFamilyOf,
  typeNameOf,
  type EditorKnob,
  type PaneFamily,
  type RendererChoices,
  type RendererEdit,
  type RenderView,
} from "@jaira/shared/browser";
import {
  RENDER_KINDS,
  enabledRenderers as enabledIn,
  familyKey,
  fileRenderers as renderersIn,
  rendererChoiceFor,
  rendererKey,
  viewRenderer as viewIn,
  viewTheme,
  type FileRenderer,
  type RenderKind,
  type SurfaceRegistry,
} from "./fileTypes";

/** What the three kinds are, in the order the strip asks about them. */
export const KINDS: Record<RenderKind, { label: string; hint: string }> = {
  text: { label: "text", hint: "the characters as they are on disk — an editor, or coloured source" },
  data: { label: "data", hint: "the value the document denotes, once parsed — a tree, a table, a form" },
  preview: { label: "preview", hint: "what the document means, rendered — prose, a page, a drawing, a board" },
};

/**
 * What the two views are CALLED, and what each one is.
 *
 * Named for what they are rather than for where they appear, which is the whole correction: "the
 * upper half" was a fact about one panel's layout and this is a fact about the file.
 */
export const VIEWS: Record<RenderView, { label: string; hint: string }> = {
  read: { label: "read-only", hint: "the view of this file that cannot be typed into" },
  write: { label: "editor", hint: "the view of this file that can" },
};

/**
 * What one screenful of this pane is looking at — a type, or a whole family.
 *
 * One shape rather than two code paths, because every control below asks the same four questions of
 * it and a branch per control is how the two get to disagree about what they are configuring.
 */
export interface Subject {
  family: PaneFamily;
  /** `null` for the family's All row. */
  mime: string | null;
}

/** The screen's questions, answered against one registry (the app's own when none is given). */
export function fileTypesModel(from?: SurfaceRegistry) {
  const fileRenderers = (mime: string, kind: RenderKind): readonly FileRenderer[] => renderersIn(mime, kind, from);
  const enabledRenderers = (mime: string, kind: RenderKind, chosen?: RendererChoices): readonly FileRenderer[] => enabledIn(mime, kind, chosen, from);
  const viewRenderer = (mime: string, kind: RenderKind, view: RenderView, chosen?: RendererChoices): FileRenderer | null => viewIn(mime, kind, view, chosen, from);

  /** The types in one family, in the order the pane lists them. */
  function membersOf(family: PaneFamily): readonly string[] {
    return PANE_TYPES.filter((mime) => paneFamilyOf(mime) === family);
  }

  /**
   * The members with a rendering of this kind at all — the only ones the question is about.
   *
   * A TypeScript file denotes no value and a CSV has nothing to render, and neither of them is
   * DISAGREEING about how those should be drawn. Leaving them out is what stops one such type from
   * making a whole family look permanently unsettled.
   */
  function contributors(family: PaneFamily, kind: RenderKind): readonly string[] {
    return membersOf(family).filter((mime) => fileRenderers(mime, kind).length > 0);
  }

  /**
   * Every renderer any member offers — the UNION, and none of them hidden.
   *
   * The intersection was tried first and it is wrong: it removed the control for anything only some of
   * the family could be drawn by, which made those settings unreachable from the one screen that exists
   * to reach them — and for two families it emptied the menu completely. What a control that cannot
   * reach everybody needs is to SAY so ({@link reachOf}), not to disappear.
   */
  function unionOffered(family: PaneFamily, kind: RenderKind): readonly FileRenderer[] {
    const seen = new Set<string>();
    const out: FileRenderer[] = [];
    for (const mime of contributors(family, kind)) {
      for (const renderer of fileRenderers(mime, kind)) {
        if (seen.has(renderer.id)) continue;
        seen.add(renderer.id);
        out.push(renderer);
      }
    }
    return out;
  }

  /** The members one renderer can actually reach. */
  function capableOf(family: PaneFamily, kind: RenderKind, id: string): readonly string[] {
    return contributors(family, kind).filter((mime) => fileRenderers(mime, kind).some((r) => r.id === id));
  }

  /** How far a control reaches, where that is not all of the family — `null` when it is. */
  function reachOf(family: PaneFamily, kind: RenderKind, id: string): string | null {
    const all = contributors(family, kind);
    const some = capableOf(family, kind, id);
    if (some.length === all.length) return null;
    return some.length <= 2
      ? `only ${some.map((mime) => typeNameOf(mime).label).join(" and ")}`
      : `${some.length} of ${all.length} types`;
  }

  /**
   * What a family says about one view, as one answer — or nothing, where it has no single one.
   *
   * Three outcomes, and the middle one is what the union buys:
   *
   *  - every member resolving the same way is the plain answer;
   *  - every member that CAN take the set renderer taking it — the rest left alone, because there was
   *    nothing else they could be — is a PARTIAL answer, carried with the count that makes it true;
   *  - anything else is disagreement, and the control shows empty rather than picking a winner.
   *
   * Resolved rather than read off the family's own line, deliberately. What a person is owed here is
   * what their files will actually look like, and a family line that three types are overriding is not
   * that.
   */
  function resolveAll(
    family: PaneFamily,
    kind: RenderKind,
    view: RenderView,
    chosen: RendererChoices,
  ): { renderer: FileRenderer | null; reaches: number; of: number; partial: boolean } | null {
    const rows = contributors(family, kind);
    if (rows.length === 0) return null;
    const picks = rows.map((mime) => viewRenderer(mime, kind, view, chosen));
    const first = picks[0] ?? null;
    if (picks.every((pick) => (pick?.id ?? "") === (first?.id ?? ""))) {
      return { renderer: first, reaches: rows.length, of: rows.length, partial: false };
    }
    const want = chosen[familyKey(family, kind)]?.[view] ?? null;
    if (want !== null) {
      const able = capableOf(family, kind, want);
      const holds = able.length > 0 && able.every((mime) => viewRenderer(mime, kind, view, chosen)?.id === want);
      if (holds) {
        const renderer = fileRenderers(able[0]!, kind).find((r) => r.id === want) ?? null;
        return { renderer, reaches: able.length, of: rows.length, partial: true };
      }
    }
    return null;
  }

  /** Whether a renderer is offered by every member it could reach — `"mixed"` when only some. */
  function offStateAll(family: PaneFamily, kind: RenderKind, id: string, chosen: RendererChoices): "on" | "off" | "mixed" {
    const able = capableOf(family, kind, id);
    if (able.length === 0) return "off";
    const on = able.filter((mime) => enabledRenderers(mime, kind, chosen).some((r) => r.id === id)).length;
    return on === able.length ? "on" : on === 0 ? "off" : "mixed";
  }

  /** Everything on offer for one kind — the type's list, or the family's union. */
  function offeredFor(at: Subject, kind: RenderKind): readonly FileRenderer[] {
    return at.mime === null ? unionOffered(at.family, kind) : fileRenderers(at.mime, kind);
  }

  /** Whether there is anything of this kind here at all, before any preference is consulted. */
  function anyFor(at: Subject, kind: RenderKind): boolean {
    return offeredFor(at, kind).length > 0;
  }

  /** What draws one view right now — `null` where a family disagrees, or where nothing can. */
  function pickFor(at: Subject, kind: RenderKind, view: RenderView, chosen: RendererChoices): FileRenderer | null {
    if (at.mime !== null) return viewRenderer(at.mime, kind, view, chosen);
    return resolveAll(at.family, kind, view, chosen)?.renderer ?? null;
  }

  /** True where a family's types are set differently — the reason a control is shown empty. */
  function mixedFor(at: Subject, kind: RenderKind, view: RenderView, chosen: RendererChoices): boolean {
    if (at.mime !== null) return false;
    return contributors(at.family, kind).length > 0 && resolveAll(at.family, kind, view, chosen) === null;
  }

  /** How far the shown answer reaches, when it does not reach all of them. */
  function spreadFor(
    at: Subject,
    kind: RenderKind,
    view: RenderView,
    chosen: RendererChoices,
  ): { reaches: number; of: number } | null {
    if (at.mime !== null) return null;
    const got = resolveAll(at.family, kind, view, chosen);
    return got !== null && got.partial ? got : null;
  }

  function offStateFor(at: Subject, kind: RenderKind, id: string, chosen: RendererChoices): "on" | "off" | "mixed" {
    if (at.mime === null) return offStateAll(at.family, kind, id, chosen);
    return enabledRenderers(at.mime, kind, chosen).some((r) => r.id === id) ? "on" : "off";
  }

  /** Whether anything is left to draw this kind — all of them refused means the kind is off. */
  function liveFor(at: Subject, kind: RenderKind, chosen: RendererChoices): boolean {
    if (at.mime !== null) return enabledRenderers(at.mime, kind, chosen).length > 0;
    return contributors(at.family, kind).some((mime) => enabledRenderers(mime, kind, chosen).length > 0);
  }

  /**
   * Choosing what draws one view — one gesture, however many keys it takes.
   *
   * On a type it is one line. On an All row it is the family's line PLUS the deletion of every
   * per-type line that disagreed with it, which is what "choosing makes them agree" means in a
   * settings file: not seven copies of the same answer, but one answer and nothing contradicting it.
   * Only the types the renderer can reach are cleared — a type it cannot draw keeps whatever it had,
   * because there is no sense in which this was an instruction about that type.
   */
  function editsForPick(at: Subject, kind: RenderKind, view: RenderView, id: string): RendererEdit[] {
    if (at.mime !== null) return [{ key: rendererKey(at.mime, kind), edit: { [view]: id } }];
    return [
      { key: familyKey(at.family, kind), edit: { [view]: id } },
      ...capableOf(at.family, kind, id).map((mime) => ({ key: rendererKey(mime, kind), edit: { [view]: null } })),
    ];
  }

  /** The same, for taking a renderer off a menu or putting it back. */
  function editsForOff(at: Subject, kind: RenderKind, id: string, chosen: RendererChoices): RendererEdit[] {
    // Only a box that is FULLY on turns off. From half-on — some types in this family offer it, some
    // do not — a press means "offer it everywhere", which is the way a tri-state box behaves wherever
    // anybody has met one, and the more useful of the two readings: half-on is a state a person
    // arrived at by accident far more often than one they chose.
    const wantOff = offStateFor(at, kind, id, chosen) === "on";
    if (at.mime !== null) {
      const was = rendererChoiceFor(at.mime, kind, chosen).off;
      const off = wantOff ? [...was, id] : was.filter((each) => each !== id);
      return [{ key: rendererKey(at.mime, kind), edit: { off } }];
    }
    const family = chosen[familyKey(at.family, kind)]?.off ?? [];
    const off = wantOff ? [...family, id] : family.filter((each) => each !== id);
    return [
      { key: familyKey(at.family, kind), edit: { off } },
      ...capableOf(at.family, kind, id).map((mime) => ({ key: rendererKey(mime, kind), edit: { off: [] } })),
    ];
  }

  /**
   * The palette one view is drawn in — or nothing, where the renderer drawing it has none.
   *
   * `null` is the common answer and is not a gap: the data tree, an authoring form, a table of rows
   * and a board are drawn in the app's own tokens, and a colour-scheme control over them would do
   * nothing. `"mixed"` is the All row's usual third position, and only the types whose pick actually
   * has a palette are polled — a type drawn by the tree is not disagreeing about colours, it has no
   * answer to give.
   */
  function resolveTheme(
    at: Subject,
    kind: RenderKind,
    view: RenderView,
    chosen: RendererChoices,
    /**
     * The palette a pick falls back to — the Editors section's one value (§6.2).
     *
     * NOT `app`, which was the first answer here and was a lie: with nothing said per type this pane
     * read "Follows the app" while the section below it read "Monokai Light" and the editors were
     * painted in Monokai Light. A settings screen stating a value the app is not using is the one
     * failure this screen is careful about, and it had it.
     */
    fallback: string,
  ): { theme: string } | "mixed" | null {
    if (at.mime !== null) {
      if (viewRenderer(at.mime, kind, view, chosen)?.themed !== true) return null;
      return { theme: viewTheme(at.mime, kind, view, chosen) ?? fallback };
    }
    const rows = contributors(at.family, kind).filter(
      (mime) => viewRenderer(mime, kind, view, chosen)?.themed === true,
    );
    if (rows.length === 0) return null;
    const paletteOf = (mime: string): string => viewTheme(mime, kind, view, chosen) ?? fallback;
    const first = paletteOf(rows[0]!);
    return rows.every((mime) => paletteOf(mime) === first) ? { theme: first } : "mixed";
  }

  /**
   * Choosing one — and `app` is WRITTEN, which is the whole of what makes it choosable.
   *
   * It used to store `null`, on the argument that the app's answer should not be copied into a
   * setting. The argument was sound and the encoding was wrong, because `null` already means something
   * else here: nothing said, fall back to the default — and the default is Monokai Light, not the
   * window. So picking "Follows the app" stored nothing, the control re-read the fallback, and the
   * menu snapped back to Monokai Light in front of the person who had just moved it. `resolveTheme`
   * had already found the display half of this and fixed it there; this is the other half.
   *
   * `null` keeps its meaning and is still what the family rows write to the members they overrule.
   */
  /**
   * Which views a palette set here reaches — every view the SAME renderer serves.
   *
   * One renderer, one palette. The theme belongs to the renderer, and a renderer serving both views is
   * one renderer: Monaco drawing the reading of a JavaScript file and Monaco drawing its editor are
   * the same component, the same grammar and the same colours, so giving them two palettes describes
   * something that does not exist.
   *
   * It also produced a bug with no way to see it. A `.js` file has no rendering apart from its own
   * text, so the panel gives the editor the whole column and the reading is never shown on its own —
   * and the pane opens on the read-only view. Setting a palette there stored it against a view nobody
   * would ever look at, while the file went on being drawn in whatever the editor's said. What that
   * looks like from the outside is a control that does nothing.
   */
  function viewsSharing(at: Subject, kind: RenderKind, view: RenderView, chosen: RendererChoices): RenderView[] {
    const here = pickFor(at, kind, view, chosen);
    const other: RenderView = view === "read" ? "write" : "read";
    if (here === null) return [view];
    return pickFor(at, kind, other, chosen)?.id === here.id ? [view, other] : [view];
  }

  function editsForTheme(
    at: Subject,
    kind: RenderKind,
    view: RenderView,
    id: string,
    chosen: RendererChoices,
  ): RendererEdit[] {
    const value = id;
    const theme = Object.fromEntries(viewsSharing(at, kind, view, chosen).map((each) => [each, value]));
    const cleared = Object.fromEntries(Object.keys(theme).map((each) => [each, null]));
    if (at.mime !== null) return [{ key: rendererKey(at.mime, kind), edit: { theme } }];
    return [
      { key: familyKey(at.family, kind), edit: { theme } },
      ...contributors(at.family, kind).map((mime) => ({ key: rendererKey(mime, kind), edit: { theme: cleared } })),
    ];
  }

  /**
   * The type the preview actually draws.
   *
   * On an All row, the first member that the chosen renderer can REACH — otherwise picking
   * `Schema-aware`, which only the JSON types have, would preview it against a CSV that will never
   * use it.
   */
  function subjectMimeOf(at: Subject, kind: RenderKind, view: RenderView, chosen: RendererChoices): string {
    if (at.mime !== null) return at.mime;
    const pick = pickFor(at, kind, view, chosen);
    const able = pick === null ? [] : capableOf(at.family, kind, pick.id);
    return able[0] ?? contributors(at.family, kind)[0] ?? membersOf(at.family)[0]!;
  }

  /** What one card of the mode strip says its kind resolves to. */
  function modeSay(at: Subject, each: RenderKind, chosen: RendererChoices): string {
    const has = anyFor(at, each);
    const live = has && liveFor(at, each, chosen);
    const read = pickFor(at, each, "read", chosen);
    const write = pickFor(at, each, "write", chosen);
    const spread = spreadFor(at, each, "read", chosen);
    return !has
      ? "—"
      : !live
        ? "off"
        : mixedFor(at, each, "read", chosen)
          ? "types disagree"
          : `${read?.label ?? "nothing"}${
              write !== null && write.id !== read?.id && !mixedFor(at, each, "write", chosen) ? `  ✎ ${write.label}` : ""
            }${spread === null ? "" : `  ${spread.reaches}/${spread.of}`}`;
  }

  /**
   * What the palette row says it is setting — both views where one renderer serves both, because that
   * is what setting it will do.
   */
  function themeCaption(at: Subject, kind: RenderKind, view: RenderView, chosen: RendererChoices): string {
    const shown = pickFor(at, kind, view, chosen);
    if (shown === null) return "";
    const named = at.mime === null ? "these types" : typeNameOf(at.mime).label;
    return `${shown.label} — the ${viewsSharing(at, kind, view, chosen).length > 1 ? "one view and the other" : `${VIEWS[view].label} view`} of ${named}`;
  }

  return { subjectMimeOf, modeSay, themeCaption, membersOf, contributors, unionOffered, capableOf, reachOf, resolveAll, offStateAll, offeredFor, anyFor, pickFor, mixedFor, spreadFor, offStateFor, liveFor, editsForPick, editsForOff, resolveTheme, viewsSharing, editsForTheme };
}

/**
 * What each type is shown holding.
 *
 * Short and real. The point of the preview is to answer "what does this renderer do to THIS kind of
 * file", so a JSON sample has nesting and a workflow sample has the fields a state actually declares
 * — a lorem string would demonstrate the frame and nothing inside it.
 */
export const SAMPLES: Record<string, string> = {
  "text/markdown": [
    "## What this shows",
    "",
    "The **real** renderer, drawing a real document — the same component the Files panel mounts.",
    "",
    "- so the preview is the thing itself",
    "- and every choice above moves it",
  ].join("\n"),
  "text/plain": [
    "the characters, exactly as they are on disk",
    "nothing is claimed about what they mean",
    "",
    "a line long enough to run past the edge of this pane, so wrapping has something to do",
  ].join("\n"),
  "application/json": JSON.stringify(
    { editorTheme: "monokai-light", renderers: { "application/json:data": { read: "tree", write: "form" } }, tabSize: 2 },
    null,
    2,
  ),
  "application/yaml": ["id: review.draft", "kind: prompt", "agent: claude-cli/default", "max_iterations: 3"].join("\n"),
  "application/toml": ['[editor]', 'theme = "monokai-light"', "tab_size = 2"].join("\n"),
  "text/csv": ["task,state,turns", "tighten the sync lint,running,3", "draft the release note,done,7"].join("\n"),
  "text/tab-separated-values": ["task\tstate\tturns", "tighten the sync lint\trunning\t3"].join("\n"),
  "text/x-diff": [
    "--- a/packages/app/src/renderer/textmate.ts",
    "+++ b/packages/app/src/renderer/textmate.ts",
    "@@ -1,3 +1,3 @@",
    "-  monaco.editor.setTheme(real);",
    "+  monaco.editor.setTheme(themeOf());",
  ].join("\n"),
  "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><circle cx="30" cy="20" r="14" fill="#2563c7"/></svg>',
  "text/html": "<h3>A page</h3>\n<p>Drawn as what it <b>means</b>, rather than as its tags.</p>",
  // Self-contained on purpose: these surfaces run Monaco's real TypeScript worker, so a sample
  // that referred to anything it could not resolve would sit under red squiggles and read as a
  // preview that is broken rather than as one that is working.
  "text/x-typescript": [
    "export function paletteOf(chosen: string, dark: boolean): string {",
    '\tif (chosen !== "app") return chosen;',
    "\t// what a person means by \u201cfollows the app\u201d",
    '\treturn dark ? "app-dark" : "app-light";',
    "}",
  ].join("\n"),
  "text/javascript": [
    "export function paletteOf(chosen, dark) {",
    '\tif (chosen !== "app") return chosen;',
    '\treturn dark ? "app-dark" : "app-light";',
    "}",
  ].join("\n"),
  "text/x-python": [
    "def palette_of(chosen, dark):",
    '\t"""The palette in use, or the app\'s own."""',
    '\tif chosen != "app":',
    "\t\treturn chosen",
    '\treturn "app-dark" if dark else "app-light"',
  ].join("\n"),
  "application/x-sh": ['set -euo pipefail', 'for f in packages/*/src/*.ts; do', '\techo "$f"', "done"].join("\n"),
  "text/css": [".ft-mode[aria-selected=\"true\"] {", "\tbackground: var(--panel);", "\tborder-bottom-color: var(--accent);", "}"].join("\n"),
  "application/xml": ['<state id="review.draft">', '  <operation kind="prompt" model="sonnet" />', "</state>"].join("\n"),
  "text/x-sql": ["select task_id, state, count(*) as turns", "from operations", "group by task_id, state;"].join("\n"),
};

const WORKFLOW_SAMPLE = JSON.stringify(
  {
    label: "Review the changeset",
    description: "Read the proposed edits and say what is wrong with them.",
    inputs: { changeset: { schema: { type: "object" } } },
    outputs: { verdict: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "Read the diff and say what is wrong with it.", model: "sonnet" },
  },
  null,
  2,
);

export function sampleFor(mime: string): string {
  if (SAMPLES[mime] !== undefined) return SAMPLES[mime];
  if (mime.includes("workflow+yaml")) return "id: review.draft\nkind: prompt\nagent: claude-cli/default";
  if (mime.includes("workflow")) return WORKFLOW_SAMPLE;
  return SAMPLES["text/plain"]!;
}

/** Whether a type carries any preference of its own — what the tree marks with a dot. */
export function typeIsSet(mime: string, chosen: RendererChoices): boolean {
  return RENDER_KINDS.some((kind) => {
    const own = chosen[rendererKey(mime, kind)];
    return own !== undefined && (own.read !== null || own.write !== null || own.off.length > 0);
  });
}


/**
 * What each editor knob is CALLED, and what its two positions mean.
 *
 * The value words are the part worth a table. A switch whose right-hand column reads "on" and "off"
 * is a column repeating the switch back at you; what belongs there is what the app will DO, which is
 * why wrap says `wrapped` against `scrolls sideways` and whitespace says what it draws rather than
 * that it is enabled.
 */
export const KNOB_WORDS: Record<EditorKnob, { label: string; on: string; off: string }> = {
  lineNumbers: { label: "Line numbers", on: "numbered", off: "no gutter" },
  wrap: { label: "Wrap long lines", on: "wrapped", off: "scrolls sideways" },
  minimap: { label: "Minimap", on: "down the right edge", off: "hidden" },
  indentGuides: { label: "Indent guides", on: "shown", off: "hidden" },
  currentLine: { label: "Mark the current line", on: "marked", off: "the caret says it" },
  whitespace: { label: "Show spaces and tabs", on: "dots and arrows", off: "hidden" },
  brackets: { label: "Colour bracket pairs", on: "Monaco's three colours", off: "the theme's own" },
  tabSize: { label: "Tab width", on: "", off: "" },
  lineHeight: { label: "Line spacing", on: "", off: "" },
};

/** The knobs that are switches, in the order they are listed. */
export const KNOB_SWITCHES: readonly EditorKnob[] = ["lineNumbers", "wrap", "minimap", "indentGuides", "currentLine", "whitespace", "brackets"];
