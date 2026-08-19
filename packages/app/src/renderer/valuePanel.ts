/**
 * Putting a value in the window's side panel, from wherever it happens to be drawn.
 *
 * A conversation shows what a model produced in the flow of what it was doing, which is the right
 * place to notice a document and the wrong place to READ one: a page rendered inside a transcript
 * row is a page in a column that scrolls away the moment the agent says anything else. The side
 * panel is the fix — the same value, held still, beside the thread rather than inside it.
 *
 * ## Why this is a context and not a prop
 *
 * `ValueView` is drawn in six places and reached through four intermediaries that have no interest
 * in this at all: a transcript row, a tool call's payload block, a fenced code block in an answer,
 * an artifact list, a file surface. Threading a callback down all of that would put a parameter
 * about the SHELL's layout into every one of them, and each new call site would have to remember to
 * pass it along or silently lose the menu item.
 *
 * A context also gets the honest failure for free. Nothing is guaranteed to be inside a provider —
 * a `ValueView` rendered in a test, or in a dialog, is not — and `useValuePanel` answering null
 * there is what lets the menu offer the item only where it would work.
 *
 * Types and a context only, with no JSX: `valueView.tsx` imports this, and the shell imports both,
 * so anything here that reached back for the viewer would close a cycle between them.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ServedArtifact, ViewHint } from "@jaira/shared/browser";

/**
 * A value, pinned — everything the panel needs to draw it exactly as the place it came from did.
 *
 * `serve` and `onPrompt` travel WITH the value rather than being supplied by the panel, and that is
 * the point of them being here. They are capabilities of a conversation — which task this artifact
 * belongs to, and which composer a message from it lands in — and the panel does not know either;
 * it is a place on screen. Carrying them means a mockup that runs in the transcript still runs when
 * it is moved over, instead of quietly degrading to a picture of itself.
 */
export interface PinnedValue {
  /** What the panel's header calls it: an artifact's path, a payload's label, or a plain noun. */
  title: string;
  value: unknown;
  /**
   * A SURFACE to show instead of the value, for the things a viewer cannot express.
   *
   * The graph's boxes are the reason: clicking one asks for a state's configuration, and that is a
   * form with a JSON tab rather than a value to render. Handed over as an element, so what the panel
   * holds is still one thing with a title and a way to close it — the alternative was a second
   * pinning mechanism beside this one, with its own place in the shell's precedence.
   *
   * It is a SNAPSHOT: its props are whatever they were when it was pinned, so anything it needs to
   * stay current it has to hold itself. See `statePanel.tsx`, which loads its own document.
   */
  node?: ReactNode;
  hint?: ViewHint | undefined;
  label?: string | undefined;
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  onPrompt?: ((text: string) => void) | undefined;
}

export interface ValuePanel {
  /** Show this in the side panel, replacing whatever was there. */
  open: (item: PinnedValue) => void;
}

export const ValuePanelContext = createContext<ValuePanel | null>(null);

/** The panel, or null where there is none — see the module note on why that is not an error. */
export function useValuePanel(): ValuePanel | null {
  return useContext(ValuePanelContext);
}
