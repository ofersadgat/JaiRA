/**
 * How each editing surface looks, as the editors themselves can ask for it (SHELL.md §6).
 *
 * The preference lives in `user-settings.json` and is parsed in `shared/settings.ts`; this is the
 * one place in the renderer that holds the CURRENT answer and tells the editors when it moves. It
 * exists because of a shape problem rather than a design flourish: Monaco and CodeMirror are both
 * created once, imperatively, inside an effect that deliberately never re-runs — re-creating either
 * would throw away the caret, the undo history and the scroll position, and there is no keystroke
 * that should cost you your place. So a setting cannot reach them as a prop. It has to be something
 * they can read on creation and be told about afterwards, which is exactly these two functions.
 *
 * ## Why not CSS custom properties for all of it
 *
 * Typography reaches Monaco that way already — `applyAppearance` writes `--font-data` and
 * `--size-editor` onto `:root`, and the editor reads them off the computed style, because a canvas
 * cannot inherit CSS. It would have worked here too, in the sense that a boolean survives a trip
 * through a string. It would also have meant every reader parsing `"1"` back into `true` and a
 * silent failure the first time somebody wrote `on`. The values are typed at rest, so they stay
 * typed: the two knobs the STYLESHEET has to know about (line spacing and tab width, for the two
 * editors that are made of DOM) are published as custom properties as well, and everything else is
 * read from here.
 *
 * ## Module state, deliberately
 *
 * A React context would be the ordinary answer and cannot do this job: the consumers are effects
 * that run once, not components that re-render, and a context read inside a `useEffect` with an
 * empty dependency list is a value frozen at mount. What the editors need is a subscription, which
 * is what {@link onEditorLook} is. It is also why {@link applyEditors} is called from the same place
 * `applyAppearance` is — one effect in the store, watching one settings field.
 */
import { EDITOR_KINDS, defaultEditors, type EditorKind, type EditorLook } from "@jaira/shared/browser";

/**
 * The looks in force. Starts at the app's own defaults, which is what a surface created before the
 * settings file has been read should draw — the same values that file would have parsed to.
 */
let looks: Record<EditorKind, EditorLook> = defaultEditors();

const watchers = new Set<() => void>();

/** What one surface looks like right now. Read at creation, and again on every notification. */
export function editorLook(kind: EditorKind): EditorLook {
  return looks[kind];
}

/**
 * Publish the looks: hold them here, write the two the stylesheet needs, and tell the live editors.
 *
 * The custom properties are per KIND rather than one pair for every editor, because the surfaces
 * genuinely disagree — the JSON editor's two layers have to lay text out identically to each other
 * and nothing else, and the markdown editor's spacing is a decision about prose. Named
 * `--ed-<kind>-lh` and `--ed-<kind>-tab`, and read by the stylesheet with the old hard-coded value
 * as the fallback, so a surface rendered before this has ever run is drawn exactly as it was.
 */
export function applyEditors(root: HTMLElement, next: Record<EditorKind, EditorLook>): void {
  looks = next;
  for (const kind of EDITOR_KINDS) {
    root.style.setProperty(`--ed-${kind}-lh`, `${next[kind].lineHeight}`);
    root.style.setProperty(`--ed-${kind}-tab`, `${next[kind].tabSize}`);
  }
  // Copied before iterating: a watcher that unsubscribes itself while being notified — which a
  // React effect cleanup running mid-update does — would otherwise mutate the set being walked.
  for (const watcher of [...watchers]) watcher();
}

/** Be told when the looks move. Returns the unsubscribe, so an effect can return it directly. */
export function onEditorLook(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}
