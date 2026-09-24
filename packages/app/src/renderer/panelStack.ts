/**
 * The side panel as a STACK — the one model every room's right-hand column reads (the person's
 * rulings, 2026-09-24; the panel-views artifact, rounds 1–8).
 *
 * The column used to be chosen by four separate rules, one per room, each with its own idea of "back":
 * a run inspector whose ← deselected the task, a task inspector that remembered one level, a state
 * inspector that had a ← only sometimes, and a pinned value that outranked all of them until its ✕.
 * Nothing had a history, so every link inside the panel threw away what the panel had been showing.
 *
 * Now there is one shape. The ROOT is what the room stands on — a task on the board, a state file, a
 * conversation in the main view — and is decided by the room's rule, not stored here as a choice. A
 * link INSIDE the panel pushes an entry on top of it; ‹ pops one; a crumb pops to its level. Choosing
 * something new in the middle replaces the root and drops everything above it, unless the stack is
 * PINNED, in which case the new root waits on an offer instead of taking the panel over.
 *
 * Pure: a value in, a new value out. The shell holds the state and the frame draws it; the rules are
 * tested here without a window.
 */
import type { PinnedValue } from "./valuePanel";
import type { TrailStep } from "./trail";

/** The tabs a task root offers. The rail's icons are these, in this order. */
export const TASK_TABS = ["conversation", "steps", "changes", "outputs", "configuration"] as const;
export type TaskTab = (typeof TASK_TABS)[number];
/** Beside a conversation that is in the MAIN view — no conversation tab, so it is never on screen twice. */
export const CONVO_TABS = ["steps", "produced", "changes", "held"] as const;
export type ConvoTab = (typeof CONVO_TABS)[number];
/** Beside a plain chat: a chat has no workflow, so no steps. */
export const CHAT_TABS = ["produced", "changes", "held"] as const;
export type ChatTab = (typeof CHAT_TABS)[number];
/** A state's three readings. Configuration is hidden while the Files editor holds the same file. */
export const STATE_TABS = ["run", "checks", "configuration"] as const;
export type StateTab = (typeof STATE_TABS)[number];

/**
 * One thing the panel can show.
 *
 * `key` is IDENTITY — two entries with the same key are the same thing, and a root whose key has not
 * changed keeps whatever tab and step the person chose on it. Everything a view needs to find its data
 * is on the entry, so a stack survives a change of room: a pinned stack is shown in whichever room the
 * person moves to, and must not depend on that room's selection to know what it is about.
 */
export type PanelEntry =
  | { kind: "task"; key: string; taskId: string; project?: string; tab: TaskTab; step?: string }
  | { kind: "convo"; key: string; taskId: string; project?: string; tab: ConvoTab; step?: string }
  | { kind: "chat"; key: string; taskId: string; project?: string; tab: ChatTab }
  | { kind: "state"; key: string; stateId: string; project: string | null; tab: StateTab }
  | { kind: "newTask"; key: string }
  | { kind: "config"; key: string; stateId: string; taskId?: string; instanceId?: string; project?: string | null }
  | { kind: "preview"; key: string; preview: PinnedValue }
  | { kind: "subagent"; key: string; taskId: string; project?: string; step: TrailStep }
  | { kind: "rerun"; key: string; taskId: string; project?: string };

export type PanelKind = PanelEntry["kind"];

/** Which way the panel moved to get here — what the frame animates. */
export type PanelMotion = "push" | "pop" | "replace" | "tab" | "none";

export interface PanelStack {
  /** Root first. Empty ⇒ the panel has nothing to say and is closed. */
  entries: readonly PanelEntry[];
  /** Pinned: a new root from the room waits on {@link offer} instead of replacing this stack. */
  pinned: boolean;
  /** What the room would show, while a pinned stack is keeping it out. */
  offer: PanelEntry | null;
  /** The person closed the panel on this root: it stays closed until the room's root changes. */
  closedOn: string | null;
  motion: PanelMotion;
}

export const EMPTY_STACK: PanelStack = { entries: [], pinned: false, offer: null, closedOn: null, motion: "none" };

export function topOf(stack: PanelStack): PanelEntry | undefined {
  return stack.entries[stack.entries.length - 1];
}

/**
 * Bring the stack into line with what the room's rule says the root is.
 *
 * - Same key: nothing changes but the tab the rule FORCES (a gate arriving takes a task to its
 *   conversation — the one time the panel moves the reader by itself), and the entry's data, which the
 *   rule may have refreshed.
 * - A different key, not pinned: the new root replaces the stack.
 * - A different key, pinned: the stack stays and the new root waits on the offer bar.
 * - No root: the panel closes, unless pinned.
 */
export function reconcile(stack: PanelStack, rule: PanelEntry | null, force?: { tab?: string }): PanelStack {
  const root = stack.entries[0];
  if (rule === null) {
    if (stack.pinned) return stack.offer === null ? stack : { ...stack, offer: null };
    return stack.entries.length === 0 && stack.closedOn === null ? stack : { ...EMPTY_STACK, motion: "replace" };
  }
  if (root !== undefined && root.key === rule.key) {
    const tab = force?.tab;
    const refreshed = { ...rule, ...("tab" in root ? { tab: tab ?? root.tab } : {}), ...("step" in root && root.step !== undefined ? { step: root.step } : {}) } as PanelEntry;
    const same = JSON.stringify(stripNode(refreshed)) === JSON.stringify(stripNode(root));
    if (same && stack.offer === null) return stack;
    const entries = same ? stack.entries : [refreshed, ...stack.entries.slice(1)];
    const moved = tab !== undefined && "tab" in root && root.tab !== tab;
    return { ...stack, entries: moved ? [entries[0]!] : entries, offer: null, motion: moved ? "tab" : stack.motion };
  }
  if (stack.pinned && stack.entries.length > 0) {
    return stack.offer?.key === rule.key ? stack : { ...stack, offer: rule };
  }
  if (stack.closedOn === rule.key) return stack;
  return { entries: [rule], pinned: false, offer: null, closedOn: null, motion: stack.entries.length === 0 ? "none" : "replace" };
}

/** A pinned value's React node does not serialise, and is not part of its identity anyway. */
function stripNode(entry: PanelEntry): unknown {
  return entry.kind === "preview" ? { ...entry, preview: { ...entry.preview, node: undefined, serve: undefined, onPrompt: undefined } } : entry;
}

/** A link inside the panel: the entry goes on top. Pushing what is already on top is a no-op. */
export function push(stack: PanelStack, entry: PanelEntry): PanelStack {
  if (topOf(stack)?.key === entry.key) return stack;
  // Pushing something already lower down pops back to it rather than stacking a second copy — a
  // trail that read `task › step › task` would be a loop, not a history.
  const at = stack.entries.findIndex((one) => one.key === entry.key);
  if (at >= 0) return { ...stack, entries: stack.entries.slice(0, at + 1), motion: "pop" };
  return { ...stack, entries: [...stack.entries, entry], closedOn: null, motion: "push" };
}

/** ‹ — one level back. The root is never popped: ✕ is how the panel is closed. */
export function pop(stack: PanelStack): PanelStack {
  if (stack.entries.length <= 1) return stack;
  return { ...stack, entries: stack.entries.slice(0, -1), motion: "pop" };
}

/** A crumb: back to that level. */
export function popTo(stack: PanelStack, index: number): PanelStack {
  if (index < 0 || index >= stack.entries.length - 1) return stack;
  return { ...stack, entries: stack.entries.slice(0, index + 1), motion: "pop" };
}

/**
 * Change a tab — on the TOP entry when it has tabs, else on the nearest entry below that does, popping
 * back to it: a tab is not a level, and choosing one on a root the stack has moved past is a way back to
 * that root.
 */
export function setTab(stack: PanelStack, tab: string, kind?: PanelKind): PanelStack {
  for (let i = stack.entries.length - 1; i >= 0; i--) {
    const entry = stack.entries[i]!;
    if (!("tab" in entry)) continue;
    if (kind !== undefined && entry.kind !== kind) continue;
    const next = { ...entry, tab } as PanelEntry;
    const entries = [...stack.entries.slice(0, i), next];
    const popping = i < stack.entries.length - 1;
    if (!popping && entry.tab === tab) return stack;
    return { ...stack, entries, motion: popping ? "pop" : "tab" };
  }
  return stack;
}

/**
 * Select a step on the nearest entry that has Steps (a task or a conversation's context), switching
 * it to its Steps tab. `undefined` closes the step's card.
 */
export function selectStep(stack: PanelStack, step: string | undefined): PanelStack {
  for (let i = stack.entries.length - 1; i >= 0; i--) {
    const entry = stack.entries[i]!;
    if (entry.kind !== "task" && entry.kind !== "convo") continue;
    const next = { ...entry, tab: "steps", ...(step !== undefined ? { step } : {}) } as PanelEntry;
    if (step === undefined && "step" in next) delete (next as { step?: string }).step;
    const popping = i < stack.entries.length - 1;
    return { ...stack, entries: [...stack.entries.slice(0, i), next], motion: popping ? "pop" : "tab" };
  }
  return stack;
}

export function pin(stack: PanelStack, on: boolean): PanelStack {
  return { ...stack, pinned: on, offer: on ? stack.offer : null, motion: "none" };
}

/** The offer bar's "Show it here": the waiting root replaces the stack, and the pin comes off. */
export function acceptOffer(stack: PanelStack): PanelStack {
  if (stack.offer === null) return stack;
  return { entries: [stack.offer], pinned: false, offer: null, closedOn: null, motion: "replace" };
}

/** ✕ — the panel closes, and stays closed until the room stands on something else. */
export function close(stack: PanelStack): PanelStack {
  const root = stack.entries[0];
  return { ...EMPTY_STACK, closedOn: root?.key ?? null, motion: "replace" };
}

/** The label a crumb shows for an entry, and the kind word after the trail. */
export function crumbOf(entry: PanelEntry): string {
  switch (entry.kind) {
    case "task":
    case "convo":
    case "chat":
    case "rerun":
      return entry.taskId;
    case "state":
    case "config":
      return entry.stateId.split("/").pop() ?? entry.stateId;
    case "newTask":
      return "new task";
    case "preview":
      return entry.preview.title;
    case "subagent":
      return `⑂ ${entry.step.name ?? entry.step.sidechain ?? entry.step.stateId}`;
  }
}

export function kindWordOf(entry: PanelEntry): string {
  switch (entry.kind) {
    case "task":
      return "the task";
    case "convo":
      return "beside the conversation";
    case "chat":
      return "beside the chat";
    case "state":
      return "the state";
    case "newTask":
      return "start one";
    case "config":
      return "as it ran";
    case "preview":
      return "a value";
    case "subagent":
      return "subagent";
    case "rerun":
      return "a copy with changes";
  }
}

/**
 * How wide an entry of each kind wants the panel, and the key its dragged width is remembered under.
 *
 * Per KIND, not per room: the content decides how wide is comfortable, so a configuration form wants
 * the same room in Files as it does in Tasks. See `uiState.ts` for the numbers.
 */
export function widthKeyOf(kind: PanelKind): string {
  switch (kind) {
    case "config":
      return "panel.config";
    case "preview":
      return "panel.preview";
    case "state":
      return "panel.state";
    default:
      return "panel.task";
  }
}

/**
 * Where a change to the SHOWN stack lands, now that a pinned stack is the window's rather than a
 * room's (the person's ruling, 2026-09-24: "a pinned context panel should be immune from any stack
 * switches … stack push/pop/etc still work normally").
 *
 * - Nothing pinned: the change is the room's — unless it PINS, when the result becomes the window's
 *   pinned stack and the room keeps its own, which goes on following the room underneath.
 * - Pinned: the change is the pinned stack's. Waving the offer away remembers which one; unpinning,
 *   taking the offer or closing hands the result to the room and ends the pin.
 *
 * `shown` is what the frame drew: the pinned stack with the room's root as its offer, or the room's.
 */
export function routeChange(
  pinned: PanelStack | null,
  shown: PanelStack,
  moved: PanelStack,
): { pinned: PanelStack | null; room?: PanelStack; dismissed?: string | null } {
  if (moved === shown) return { pinned };
  if (pinned === null) {
    if (moved.pinned) return { pinned: { ...moved, offer: null }, dismissed: null };
    return { pinned: null, room: moved };
  }
  if (!moved.pinned) return { pinned: null, room: { ...moved, offer: null }, dismissed: null };
  return {
    pinned: { ...moved, offer: null },
    ...(moved.offer === null && shown.offer !== null ? { dismissed: shown.offer.key } : {}),
  };
}

/** What the frame draws: the pinned stack, offering the room's root when it stands elsewhere; else the room's. */
export function shownStack(pinned: PanelStack | null, room: PanelStack, dismissed: string | null): PanelStack {
  if (pinned === null) return room;
  const root = room.entries[0];
  const offer = root !== undefined && root.key !== pinned.entries[0]?.key && root.key !== dismissed ? root : null;
  return { ...pinned, pinned: true, offer };
}
