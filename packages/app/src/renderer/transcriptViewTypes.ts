/**
 * What a surface LENDS the transcript it shows: the right to replace a message already sent, and a
 * way to run an artifact. A transcript handed neither offers neither. The universal transcript
 * (`packages/universal/src/components/panel/SessionTranscript.tsx`) takes them. Types only.
 */
import type { ServedArtifact } from "@jaira/shared/browser";

/**
 * Replacing a message that was already sent — what the Chat view lends its transcript.
 *
 * Two halves because they are two different pieces of knowledge and only the host has either: which
 * turns can be replaced at all (`can`), and what to do when one is (`edit`). A transcript beside a
 * board is handed neither and shows no edit buttons, which is correct — a run's prompt came from the
 * workflow, and rewriting it after the fact would be a record of a run that never happened.
 */
export interface EditMessage {
  can: (turn: number) => boolean;
  edit: (turn: number, text: string) => void;
  /**
   * Which CUT this message can be the point of, if any — see `cut.ts`.
   *
   * A message that begins a turn is cut BEFORE: it and everything after it go. A reply ends one and
   * is cut AFTER: it stays, and everything after it goes. Both land on the same kind of point — the
   * start of the next turn in the journal — so the sentence in the tooltip is the only thing that
   * differs. `undefined` means neither verb is offered here: nothing comes after this message, or
   * the journal does not name its turn.
   */
  cut?: ((turn: number) => "before" | "after" | undefined) | undefined;
  /**
   * Delete from the cut on, then carry on from there.
   *
   * Not the fork {@link edit} makes: a rewind KEEPS nothing. It ARMS the deletion — the transcript
   * shows what would go and the host asks in words — and the host does it when the person says so.
   */
  rewind?: ((turn: number, text: string) => void) | undefined;
  /**
   * A second conversation sharing everything before the cut. Arms the host's composer: the next
   * message is what starts the new conversation, so nothing exists until one is sent.
   */
  fork?: ((turn: number, text: string) => void) | undefined;
}

/**
 * Showing an artifact that RUNS — what a surface hands the transcript so a mockup can be interactive.
 *
 * Two capabilities, deliberately separate. `serve` is what makes the frame possible at all; `onPrompt`
 * is where a message from inside it goes, and a surface may offer the first without the second — a
 * transcript beside a board can show a working mockup while having no composer for it to talk to.
 */
export interface ArtifactSurface {
  /** Grant this artifact an address a frame can load. See `ipc.ts`'s `ServeArtifactRequest`. */
  serve: (path: string) => Promise<ServedArtifact>;
  /** Put text in front of the user, for them to send or discard. Never sends by itself. */
  onPrompt?: ((text: string) => void) | undefined;
}
