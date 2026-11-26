import type { ChatState } from "./store";

/**
 * The Chat view as a window arrives at another project — clicked in the sidebar, opened, made new, or
 * a workspace of it on another machine: a new conversation there. The one that was open belongs to
 * the place just left; kept, the thread was asked for under a project that does not hold it, and the
 * composer under it read like the new project's start page while it typed into that other
 * conversation (2026-11-26: a project's first prompt, sent from that box, went nowhere). Where the
 * next one runs and what it was carried with were picked for the old place too. `busy` stays: a
 * conversation being started still lands where it was asked to.
 */
export function chatOnArriving(chat: ChatState): ChatState {
  const { runOn: _runOn, settings: _settings, walkedInto: _walked, walkedChain: _chain, ...rest } = chat;
  return { ...rest, taskId: null, project: null, opening: null, error: null };
}
