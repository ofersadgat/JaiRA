/**
 * Monaco's diff, code pane and coloured reading, as this app hosts them.
 *
 * The editors themselves live in `codeview`, which JaiRA shares with topodiff: worker wiring, the
 * TextMate layer, the one Monaco theme, the providers that answer from a {@link CodeIntel}, and the
 * panes. What stays here is what only this app knows, handed to `codeview` once (`configureCodeview`):
 *
 *  - **Which palette.** A palette is chosen per type and per view (`fileTypes.ts`), and Monaco has one
 *    theme, so the editor in front decides (`editorFront.ts`). Each pane names its key as `palette`;
 *    `codeview` hands it back when the pane comes to the front, and asks for the theme of whatever is
 *    in front now, which may be an editor `codeview` does not draw, such as the markdown editor.
 *  - **The look and the face.** `editorLook.ts` per surface; the font from the root's tokens.
 *  - **When to repaint.** A palette choice, a new editor in front, a look, or the root's theme, size
 *    and palette attributes moving.
 *
 * The three components keep their props, so the islands and the universal page are unchanged.
 */
import type { JSX } from "react";
import { monacoGrammarOf, type RenderView } from "@jaira/shared/browser";
import { codeviewChanged, configureCodeview } from "codeview/host";
import { CodeText as CodeviewText, MonacoCodePane as CodeviewCodePane, MonacoDiffPane as CodeviewDiffPane } from "codeview/monaco";
import { editorLook, onEditorLook } from "./editorLook";
import { EDITOR_THEME_APP } from "./editorThemes";
import { onRenderChoice, renderChoicesNow, useRenderChoice } from "./renderChoice";
import { editorFrontNow, onEditorFront, takeEditorFront, type EditorFront, type PaletteKey } from "./editorFront";
import { viewTheme } from "./fileTypes";
import type { CodeIntel, MonacoDiffProps } from "./monacoDiffTypes";

/**
 * Which palette the editor in front should be in. The renderer's own key first, where it has one (a
 * diff is `Side by side`, drawing some other type), then the type's text view, then the Editors
 * section's one value, which is the palette for everything nobody has said anything about.
 */
function wantedThemeId(): string {
  const inFront = editorFrontNow();
  const chosen = renderChoicesNow();
  const perType =
    inFront === undefined
      ? null
      : (inFront.palette === undefined ? null : viewTheme(inFront.palette.mime, inFront.palette.kind, inFront.palette.view, chosen)) ??
        viewTheme(inFront.mime, "text", inFront.view, chosen);
  return perType ?? document.documentElement.dataset["editorTheme"] ?? EDITOR_THEME_APP;
}

/**
 * The editor's face and size, read off the tokens the rest of the app uses. Monaco draws into a canvas
 * and cannot inherit CSS, so the two values are read from the computed style and passed as options.
 */
function editorFont(): { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(style.getPropertyValue("--size-editor"));
  return { fontFamily: style.getPropertyValue("--font-data").trim(), fontSize: Number.isFinite(size) && size > 0 ? size : 12 };
}

configureCodeview({
  theme: () => wantedThemeId(),
  dark: () => document.documentElement.dataset["theme"] === "dark",
  look: (kind) => editorLook(kind),
  font: editorFont,
  front: (ask) => {
    if (ask.key !== undefined) takeEditorFront(ask.key as EditorFront);
  },
  owner: "jaira",
  name: "jaira",
});
onRenderChoice(codeviewChanged);
onEditorFront(codeviewChanged);
onEditorLook(codeviewChanged);
// Theme and typography are both written onto the root, one as data attributes and the other as
// inline custom properties, so one observer follows a palette switch and a size slider as they move.
new MutationObserver(codeviewChanged).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-editor-theme", "style"] });

/**
 * Where a side-by-side pane's palette lives: the `Side by side` renderer's own key. True of every host
 * that mounts one, since a person who picks a scheme under Changes means it for diffs.
 */
const DIFF_PALETTE: PaletteKey = { mime: "text/x-diff", kind: "preview", view: "read" };

export function MonacoDiffPane({ original, modified, mime, onModified, onSelect, onReady, readOnly, sideBySide, file, intel }: MonacoDiffProps): JSX.Element {
  return (
    <CodeviewDiffPane
      original={original}
      modified={modified}
      language={monacoGrammarOf(mime)}
      {...(file !== undefined ? { path: file } : {})}
      sideBySide={sideBySide !== false}
      readOnly={readOnly === true}
      palette={{ mime, view: "read", palette: DIFF_PALETTE } satisfies EditorFront}
      {...(onModified !== undefined ? { onModified } : {})}
      {...(onSelect !== undefined ? { onSelect } : {})}
      {...(onReady !== undefined ? { onReady } : {})}
      {...(intel !== undefined ? { intel } : {})}
    />
  );
}

export function MonacoCodePane({
  text,
  mime,
  onChange,
  readOnly,
  autoHeight,
  view,
  file,
  intel,
  reveal,
}: {
  text: string;
  mime: string;
  /** Somewhere for a change to go. ABSENT means read-only (`MarkdownDocumentProps.onChange` says why). */
  onChange?: ((text: string) => void) | undefined;
  /** Take the height of the content rather than of the container: a block inside a document. */
  autoHeight?: boolean | undefined;
  /** Which of the type's two views this pane draws, and so which palette it asks for. `write` unless told. */
  view?: RenderView | undefined;
  /** The file this text IS, absolute: its name, which picks the script kind and names diagnostics. */
  file?: string | undefined;
  intel?: CodeIntel | undefined;
  /** Where to put the caret once, on the way in. */
  reveal?: { line: number; column: number } | undefined;
  /** Mounted, coloured, and refusing every keystroke, even with somewhere for a change to go. */
  readOnly?: boolean | undefined;
}): JSX.Element {
  return (
    <CodeviewCodePane
      text={text}
      language={monacoGrammarOf(mime)}
      onChange={onChange}
      autoHeight={autoHeight}
      view={view ?? "write"}
      file={file}
      intel={intel}
      reveal={reveal}
      readOnly={readOnly}
      palette={{ mime, view: view ?? "write" } satisfies EditorFront}
    />
  );
}

/**
 * One text, coloured, with no editor behind it: a fenced block, or a whole file in the code view. Its
 * palette is the type's reading's, or `theme` for the settings preview showing one not chosen yet.
 */
export function CodeText({ text, mime, theme }: { text: string; mime: string; theme?: string | undefined }): JSX.Element {
  const chosen = useRenderChoice();
  const wanted = theme ?? viewTheme(mime, "text", "read", chosen) ?? document.documentElement.dataset["editorTheme"];
  return <CodeviewText text={text} language={monacoGrammarOf(mime)} theme={wanted} />;
}
