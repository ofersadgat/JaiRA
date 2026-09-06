/**
 * Which type and view Monaco's one palette currently belongs to.
 *
 * Monaco has a single theme: `setTheme` repaints every editor on the page, a per-editor `theme`
 * option goes through the same call, and the token classes are indices into one colour map, so two
 * editors in two palettes is not something the mechanism can express (see `textmate.ts`). The honest
 * reading of "a palette per type" for editors is therefore *the one in front wins*, and this is the
 * one in front.
 *
 * Its own module rather than a variable inside `monacoDiff.tsx` because two very different callers
 * need it and only one of them can afford to import that file. Monaco is megabytes behind a lazy
 * boundary; the settings pane is a form. This is a name, a setter and a subscription.
 *
 * ## Why anything but an editor sets it
 *
 * Because "in front" is about ATTENTION, and an editor cannot always tell. Two settings previews sit
 * on the Appearance screen — the File types one, which exists to show what a palette does to a type,
 * and the Editors one, which exists to show what a knob does to a surface — and both are Monaco.
 * They mount within a frame of each other, so whichever lost the race owned the window's palette and
 * the control right beside the other one appeared to do nothing at all. That was the bug: a person
 * chose a colour scheme, the setting was stored, the swatches changed, and the editor under it did
 * not move.
 *
 * So the pane whose subject the palette IS says so, and says so again whenever that subject changes.
 * A creation still claims the palette, because opening a file should colour it without being clicked
 * first; a focus still claims it, because that is what looking at a thing means.
 */
import type { RenderView } from "@jaira/shared/browser";

/** A type and one of its two views — the pair a palette is keyed by (`RendererChoice.theme`). */
export interface EditorFront {
  mime: string;
  view: RenderView;
}

let front: EditorFront | undefined;
const watchers = new Set<() => void>();

/**
 * Claim the window's palette for this type and view.
 *
 * Idempotent: claiming what is already claimed notifies nobody, which is what keeps a focus event on
 * an editor that never lost focus from repainting the page.
 */
export function takeEditorFront(next: EditorFront): void {
  if (front !== undefined && front.mime === next.mime && front.view === next.view) return;
  front = next;
  for (const watch of [...watchers]) watch();
}

/** What is claimed, or `undefined` before anything has drawn code. */
export function editorFrontNow(): EditorFront | undefined {
  return front;
}

/** Be told when it moves — how Monaco learns to repaint without being re-created. */
export function onEditorFront(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}
