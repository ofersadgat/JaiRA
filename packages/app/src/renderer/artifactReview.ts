/**
 * What `review_artifact` and `edit_artifact` decide, apart from how they are drawn: reading the
 * artifact, reading the edit, wording the verdict and shaping the answer. The artifact gates
 * (`packages/universal/src/components/artifact/`) draw from it.
 */
import {
  artifactOf,
  diffStrategyFor,
  displayText,
  editorKindOf,
  mimeOfPath,
  sendBackOption,
  type Change,
  type ComponentOption,
  type ReviewNote,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import type { DraftBox } from "./drafts";

/** An input as the artifact pane reads it: its text, and the type it declares (or its path implies). */
export function artifactShapeOf(value: unknown): { seed: string; mime: string | undefined } {
  const seed = value === undefined ? "" : displayText(value);
  const artifact = artifactOf(value);
  const mime = artifact?.mime ?? (artifact?.path === undefined ? undefined : mimeOfPath(artifact.path));
  return { seed, mime };
}

/**
 * A draft box that holds what a person SUBMITTED, over what they were shown.
 *
 * The artifact panes read their edit through a {@link DraftBox}, and a settled gate has no live
 * draft — it has the content that came back, when the person changed it. Handing that in as the
 * box's text draws the pane in its changes reading, which is the edit they made, rather than the
 * original with no sign anything happened to it.
 */
export function recordedDraft(seed: string, content: JsonValue | undefined): DraftBox {
  const text = typeof content === "string" ? content : seed;
  return { text, dirty: text !== seed, set: () => undefined, revert: () => undefined };
}

/**
 * Which reading the pane is on — DERIVED, not chosen: markdown shows a change without leaving the
 * document (`prose`); anything else shows the edit as a change once there is one (`changes`), and the
 * value itself until then (`value`).
 */
export function artifactReadingOf(mime: string | undefined, seed: string, dirty: boolean): "prose" | "changes" | "value" {
  if (editorKindOf(mime, seed) === "markdown") return "prose";
  return dirty ? "changes" : "value";
}

/**
 * The edit as a {@link Change}: `before` what arrived, `after` the draft, hunked by the registry's
 * strategy for the type — so a JSON artifact diffs structurally and a prose one by line.
 */
export function artifactChangeOf(artifactId: string, seed: string, draft: string, mime: string | undefined): Change {
  return {
    id: artifactId,
    path: artifactId,
    action: "update",
    before: seed,
    after: draft,
    hunks: diffStrategyFor(mime ?? "text/plain").hunks(seed, draft),
  };
}

/**
 * What the review's footer says, and whether it collapses to one button.
 *
 * A review with anything written on it is not an approval — it is a round going back — and the
 * button has to say so before it is pressed. What it SUBMITS is the author's send-back option
 * (`sendBackOption`). A vocabulary with no send-back word (`merged` / `reverted`) cannot collapse to
 * one button honestly, so the row stays and the comment rides alongside whatever is clicked.
 */
export function reviewVerdictOf(
  options: readonly ComponentOption[],
  comments: string,
  notes: number,
): { speaking: boolean; collapsed: boolean; sendBack: ComponentOption | undefined; sendBackLabel: string; verdict: string } {
  const speaking = comments !== "" || notes > 0;
  const sendBack = sendBackOption(options);
  const collapsed = speaking && sendBack !== undefined;
  const sendBackLabel = sendBack === undefined ? "" : (sendBack.label ?? sendBack.value);
  const verdict = collapsed
    ? `comments left — this goes back as "${sendBackLabel}"`
    : speaking
      ? "comments left — your decision goes back with them"
      : "no comments — your decision stands on its own";
  return { speaking, collapsed, sendBack, sendBackLabel, verdict };
}

/** The review's answer: the decision, the comment and notes when there are any, and the edit only when it differs. */
export function reviewAnswerOf(decision: string, comments: string, notes: readonly ReviewNote[], draft: { dirty: boolean; text: string }): Record<string, unknown> {
  return {
    decision,
    ...(comments === "" ? {} : { comments }),
    ...(notes.length > 0 ? { notes } : {}),
    // Only when they actually changed it: content equal to what arrived is not an edit.
    ...(draft.dirty ? { content: draft.text } : {}),
  };
}

/** "1 note", "3 notes". */
export const notesCount = (n: number): string => (n === 1 ? "1 note" : `${n} notes`);
