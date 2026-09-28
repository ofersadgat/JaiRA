/**
 * What a gate's heading says beside the author's question — moved out of `components.tsx` unchanged so
 * the universal copy of the gate (decision 0015) draws the same glyph. Pure.
 */
import type { ComponentName } from "@jaira/shared/browser";
import type { PATHS } from "./icons";

/**
 * A glyph per component, shown beside its NAME in the dialog's sub-line.
 *
 * Beside the name rather than in the heading: the heading is the author's prompt, in their words,
 * and a picture next to a sentence is decoration. The sub-line already says `review_artifact` in
 * wire spelling, which is exactly the kind of label a glyph makes findable at a glance.
 */
export const COMPONENT_ICON: Record<ComponentName, keyof typeof PATHS> = {
  choose_option: "choice",
  review_artifact: "read",
  review_artifacts: "files",
  edit_artifact: "pencil",
  fill_form: "form",
  confirm_action: "check",
  approve_tool_call: "shield",
};
