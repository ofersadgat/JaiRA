/**
 * The Components view: every surface the app can put in front of a person, and every variation of
 * it, with nothing behind any of them (DESIGN §11.4).
 *
 * It used to be the last section of the Debug view, and that was the wrong room for it. Debug asks
 * "does a workflow run here" and is reached for when something is broken; this asks "what does a
 * gate look like, and what does an answer to it return", and is reached for while AUTHORING one —
 * a `fill_form` with a `custom` field, a `choose_option` carrying five questions — to see the shape
 * before a run has to reach it. Two questions, two rooms, and the second no longer sits under a
 * self-test it has nothing to do with.
 *
 * The pane is a heading and the gallery itself. Everything about a row — the carousel, the bar that
 * slides every row to one variant, the real dialog, the editable config, the contract check on what
 * was submitted — is `componentGallery.tsx`'s, unchanged by the move.
 */
import { type JSX } from "react";
import type { ValidateSchemaResult } from "@jaira/shared/browser";
import { ComponentGallery } from "./componentGallery";

export interface GalleryPaneProps {
  /** The schema check, over IPC — the store's, the same one every JSON editor in the app uses. */
  validateSchema: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
}

export function GalleryPane({ validateSchema }: GalleryPaneProps): JSX.Element {
  return (
    <div className="view gallery-view">
      <div className="col mid gallery-page">
        <header className="gallery-page-head">
          <h2>Components</h2>
          <p className="sub">
            Every surface a run can put in front of you, with nothing behind it: the six built-in UI
            components a state&apos;s <code>operation.function</code> may name, the fallback for one it
            may not, and the two dialogs JaiRA raises on its own — a command approval and an agent&apos;s
            question. One row each; flip through the variations its config can express, or use the bar
            to send every row to the same one. Each card renders the REAL dialog from the config beside
            it — so editing the config is editing what you see, and answering it shows what a
            state&apos;s declared outputs would receive.
          </p>
        </header>
        <ComponentGallery validateSchema={validateSchema} />
      </div>
    </div>
  );
}
