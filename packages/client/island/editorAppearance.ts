import { defaultEditors } from "@jaira/shared/browser";
import { applyAppearance } from "@jaira/ui/appearance";
import { applyEditors } from "@jaira/ui/editorLook";
import { publishRenderChoices } from "@jaira/ui/renderChoice";
import type { IslandLook } from "./protocol";

/**
 * What the store does to a web page's root for an editor, done to the island page's (decision 0015):
 * the typography and the editors' own palette (`applyAppearance`), how each editor is drawn
 * (`applyEditors`) and the palette chosen per type (`publishRenderChoices`) — the three channels
 * Monaco, CodeMirror and the schema editor follow while they are open. The same functions, with the
 * appearance block the host sends in `IslandLook.appearance`.
 *
 * Only when it moved: every render carries the look, a render goes out per keystroke in an editor,
 * and each of these tells the live editors to repaint.
 */
let applied = "";

export function applyEditorAppearance(look: IslandLook): void {
  const a = look.appearance;
  if (a === undefined) return;
  const key = JSON.stringify(a);
  if (key === applied) return;
  applied = key;
  const root = document.documentElement;
  applyAppearance(root, a);
  // Every kind, whatever arrived: `applyEditors` publishes all four.
  applyEditors(root, { ...defaultEditors(), ...a.editors });
  publishRenderChoices(a.renderers);
}
