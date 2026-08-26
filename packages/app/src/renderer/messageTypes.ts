/**
 * Remembering that somebody told the app what a message actually is.
 *
 * `viewsFor` sniffs, and sniffing is deliberately timid — `looksLikeMarkdown` wants two marks before
 * it will offer a rendering, so a plan written as one paragraph with a single backtick pair is shown
 * as what it looks like rather than as what it is. That was defensible while sniffing was the only
 * answer available. It stops being defensible the moment a person can simply say: this is markdown.
 *
 * What they say has to survive. A correction you re-make every time you open a thread is not a
 * correction, it is a chore, so this is stored the way every other position in the window is stored
 * — in `JairaUiState.modes`, the map that already exists for controls with more than two positions
 * (see `uiState.ts`). It is a preference about how one person reads one conversation, which is
 * exactly what that file is for; it never touches the record, and it never touches `settings.json`.
 *
 * ## Why a context rather than a prop
 *
 * The same argument `valuePanel.ts` makes. A message is drawn by `Message`, which is reached through
 * `Transcript`, which is reached through a session band, a fork seam or a chat pane — none of which
 * have any interest in where a preference is kept. Threading a store through all of that would put
 * a parameter about the settings file into every one of them.
 *
 * And the honest failure comes free: a transcript rendered outside a provider gets `null`, the chip
 * falls back to component-local state, and the correction still works for as long as the view is
 * open. Nothing is broken by the absence — only the remembering is.
 *
 * ## What a key is
 *
 * `<scope>` for the conversation and `<scope>@<turn>` for one message in it, where the scope is
 * supplied by whatever is drawing the transcript: a task id in the Chat view, a session id in a
 * run's bands. Two levels because both corrections are real ones — "this message is markdown" and
 * "everything this agent says is markdown" — and the second is the one you reach for on the third
 * time you make the first.
 */
import { createContext, useContext } from "react";

/** The prefix every key here carries, so a settings file says where its entries came from. */
const NS = "msgtype";

/** The key one message's override is stored under. `turn` is absent for anything not yet recorded. */
export function typeKeyOf(scope: string, turn?: number | undefined): string {
  return turn === undefined ? `${NS}.${scope}` : `${NS}.${scope}@${turn}`;
}

/**
 * Where type overrides are kept.
 *
 * Deliberately a bare string map rather than anything that knows what a message is: the store holds
 * positions by id and has never needed to know what any of them mean, and this is one more of those.
 * `undefined` from {@link get} means nothing has been asserted, which is what lets the sniffer run.
 */
export interface MessageTypeStore {
  get: (key: string) => string | undefined;
  /** `undefined` clears the assertion, which puts the value back in the sniffer's hands. */
  set: (key: string, mime: string | undefined) => void;
}

export const MessageTypeContext = createContext<MessageTypeStore | null>(null);

/** The store, or null where nothing is remembering — see the module note on why that is not an error. */
export function useMessageTypes(): MessageTypeStore | null {
  return useContext(MessageTypeContext);
}
