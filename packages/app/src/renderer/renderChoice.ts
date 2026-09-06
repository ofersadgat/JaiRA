/**
 * Which renderer draws a type, where the component asking is too deep to be handed the answer.
 *
 * The preference itself is one map in `user-settings.json` (`JairaSettings.renderers`, keyed by
 * `"<mime>:<text|data|preview>"` — see `RenderKind`) and it is read in two quite different places:
 *
 *  - **The Files panel** resolves a surface for the file it is opening, and gets the map through
 *    `FileSurfaceContext` — an explicit prop, because there is exactly one panel and it already
 *    carries thirty other things the shell decided.
 *  - **A value view** draws a fenced block in a document, a tool result in a transcript, an artifact
 *    in a gate. There are dozens of those, nested arbitrarily deep inside components that know
 *    nothing about settings, and threading a map through all of them to answer "should this source
 *    be an editor or coloured text" would be the wrong trade by a wide margin. It asks about the
 *    TEXT renderer, the same one the Files panel opens the file with — see {@link textRendererFor}.
 *
 * So the map is published here as well, and read with {@link useRenderChoice}. Not a second source
 * of truth: `store.ts` publishes the same field it puts on the context, in the same effect, so the
 * two cannot disagree about what was chosen — this is a delivery route, not a copy.
 *
 * ## Why a subscription rather than a module-level read
 *
 * Consumers are components. A module variable read during render is a value React never learns has
 * changed, so a person flipping the choice in Settings would see it apply to the next block that
 * happened to re-render and nowhere else. `useSyncExternalStore` is the supported way to read
 * outside-React state, and it makes a settings change repaint every value in the window at once.
 */
import { useSyncExternalStore } from "react";
import type { RendererChoices, RendererId } from "@jaira/shared/browser";
import { rendererChoiceFor } from "./fileTypes";

/** The published map. Empty until the store hydrates, which is every default. */
let choices: RendererChoices = {};

const watchers = new Set<() => void>();

/** Publish the preferences — called from the store's settings effect, beside `applyEditors`. */
export function publishRenderChoices(next: RendererChoices): void {
  if (next === choices) return;
  choices = next;
  for (const watcher of [...watchers]) watcher();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/**
 * The whole map, as a value a component may read.
 *
 * The map rather than one answer, because the identity is what `useSyncExternalStore` compares: a
 * hook returning a looked-up string would be fine, and a hook returning a fresh object every call
 * would loop forever. This returns the published object itself.
 */
export function useRenderChoice(): RendererChoices {
  return useSyncExternalStore(subscribe, () => choices, () => choices);
}

/**
 * The same map, read imperatively — for the callers that are not components.
 *
 * Monaco is created inside an effect and lives outside React afterwards: the editor asks what
 * palette it should be in when it is made and again when it takes focus, and neither moment is a
 * render. This is that reader, and it is the same object the hook returns, so the two can never
 * disagree about what is currently chosen.
 */
export function renderChoicesNow(): RendererChoices {
  return choices;
}

/**
 * Be told when it changes — for the same callers that read it imperatively.
 *
 * Monaco is the reason. It is created inside an effect and lives outside React afterwards, so a
 * changed preference cannot reach it as a prop: without this, choosing a palette for a type left
 * every editor already on screen painted in the old one until it was closed and reopened. The
 * theme's other two channels are the root's attributes and `onTextMate`; this is the third.
 */
export function onRenderChoice(watch: () => void): () => void {
  return subscribe(watch);
}

/**
 * Which TEXT renderer this person wants for a type, in the two names a value view knows.
 *
 * The same preference the Files panel reads for the lower half of the panel (`<mime>:text`), asked
 * by a surface that has fewer renderers to offer. A value view draws source two ways — an editor, or
 * coloured text that cannot be typed into — so the several editors the file panel distinguishes
 * between (the live preview, the schema-aware one) all mean `monaco` here: they are editors, and
 * this reader cannot mount them inside a fenced block.
 *
 * That collapse is the point of answering it here rather than storing a second preference. "Draw my
 * source as coloured text rather than as an editor" is ONE statement about a type, and a person who
 * makes it in Appearance means it in a document as much as in the Files panel.
 *
 * Walks `mimeFallbacks` for the same reason every other resolution in this app does: a vendor type
 * is written IN a syntax, so a choice about `application/json` reaches a workflow that is JSON —
 * unless the workflow type carries a choice of its own, which the walk finds first.
 *
 * Pure, and takes the map rather than reading the module, so the caller decides when it re-renders
 * and a test can ask the question without publishing anything.
 */
export function textRendererFor(mime: string | undefined, chosen: RendererChoices): RendererId | undefined {
  if (mime === undefined || mime === "") return undefined;
  // The READ view, because that is what a fenced block inside a document is: a reading of source
  // somebody is looking at, never the place they change it. The write view belongs to the panel that
  // opened the file itself.
  const want = rendererChoiceFor(mime, "text", chosen).read;
  if (want === null) return undefined;
  return want === "codeview" ? "codeview" : "monaco";
}
