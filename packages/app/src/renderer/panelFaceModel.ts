/**
 * What a task-shaped panel entry SAYS, as data — its tabs, their counts, its verbs, the line under its
 * name — moved out of `panelFaces.tsx` and `sidePanel.tsx` unchanged so the universal copy of the panel
 * (decision 0015, `packages/universal/src/app/PanelColumn.tsx`) derives the same face from the same
 * rules. Nothing here draws; `panelFaces.tsx` turns it into the DOM's face.
 */
import type { InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { EVENTS_STATE_ID } from "@jaira/shared/browser";
import type { PATHS } from "./iconPaths";
import { push, type PanelStack } from "./panelStack";
import { stoppedAction } from "./taskAction";

type IconKey = keyof typeof PATHS;

/** One tab of an entry. `id` is what `PanelEntry.tab` holds. */
export interface PanelTabSpec {
  id: string;
  label: string;
  icon: IconKey;
  /** A count or a short figure after the label — also the badge on the folded rail. */
  count?: number | string | undefined;
  /** The count's tone: something waiting on you (amber), live (accent), failed (red). */
  tone?: "amber" | "accent" | "red" | undefined;
}

/** A verb in the head, drawn as an icon with its name as the tooltip. */
export interface PanelVerb {
  icon: IconKey;
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  /** The verb that matters most — drawn filled. At most one. */
  primary?: boolean | undefined;
  danger?: boolean | undefined;
}

/** The glyph a tab id is drawn with when a face does not say — shared by the rail and the strip. */
export const TAB_ICONS: Record<string, IconKey> = {
  conversation: "comment",
  steps: "plan",
  changes: "typeChanges",
  outputs: "typeData",
  configuration: "form",
  produced: "files",
  held: "pin",
  run: "play",
  checks: "check",
};

/**
 * A status's glyph — the badge before a task's name (`board.tsx`'s `Badge`). Still nine entries wide:
 * a panel describing ONE task is where `timeout` and `failed` are worth telling apart.
 */
export const BADGE: Record<string, string> = {
  running: "▶",
  waiting_for_user: "⏸",
  blocked: "⛔",
  completed: "✓",
  failed: "✗",
  canceled: "∅",
  timeout: "⏱",
  queued: "·",
  interrupted: "⚠",
};

/** The events task (decision 0010 §4): the one task whose configuration is its automations. */
export const isEventsTask = (detail: TaskDetail | null): boolean => detail?.workflow === EVENTS_STATE_ID;

/** A tab with its icon filled in from the shared table. */
export const tab = (id: string, label: string, extra: Omit<PanelTabSpec, "id" | "label" | "icon"> = {}): PanelTabSpec => ({ id, label, icon: TAB_ICONS[id] ?? "note", ...extra });

export function countSteps(nodes: readonly InstanceNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.children.length === 0 ? 1 : countSteps(node.children)), 0);
}

/** Badges for a task's tabs: a question waiting, a run going. `gate` is the parked gate the host holds. */
export function taskTabs(gate: { pending: PendingInteraction } | undefined, detail: TaskDetail | null, withConversation: boolean): PanelTabSpec[] {
  const waiting = gate !== undefined && detail !== null && (gate.pending.taskId === detail.taskId || gate.pending.about === detail.taskId);
  const live = detail?.status === "running";
  const steps = detail === null ? 0 : countSteps(detail.instances);
  return [
    ...(withConversation ? [tab("conversation", "Conversation", waiting ? { count: "!", tone: "amber" } : live ? { count: "•", tone: "accent" } : {})] : []),
    tab("steps", "Steps", steps > 0 ? { count: steps } : {}),
    tab("changes", "Changes", {}),
    tab("outputs", "Outputs", {}),
    ...(withConversation ? [tab("configuration", isEventsTask(detail) ? "Automations" : "Configuration")] : []),
  ];
}

/** What {@link taskVerbsOf} needs from the panel's host. */
export interface VerbHost {
  startAgain: (taskId: string) => void;
  cancel: (taskId: string) => void;
  onStack: (next: (stack: PanelStack) => PanelStack) => void;
  adoptTask: (taskId: string, project: string | undefined, workflow: string) => void;
}

/** The verbs every task-shaped entry carries, as icons. */
export function taskVerbsOf(host: VerbHost, detail: TaskDetail, project: string | undefined, adopt: boolean): PanelVerb[] {
  const action = stoppedAction(detail);
  const live = detail.status === "running" || detail.status === "queued" || detail.status === "stopping";
  const verbs: PanelVerb[] = [];
  if (!live) {
    verbs.push({ icon: "play", label: action?.verb ?? (detail.runs.length > 0 ? "Re-run" : "Start"), primary: true, onClick: () => host.startAgain(detail.taskId) });
  }
  if (live || detail.status === "interrupted") verbs.push({ icon: "stop", label: "Cancel", onClick: () => host.cancel(detail.taskId) });
  if (detail.runs.length > 0 && !live) {
    verbs.push({
      icon: "pencil",
      label: "Re-run with changes",
      onClick: () => host.onStack((was) => push(was, { kind: "rerun", key: `rerun:${detail.taskId}`, taskId: detail.taskId, ...(project !== undefined ? { project } : {}) })),
    });
  }
  if (adopt) verbs.push({ icon: "adopt", label: "Show the conversation in the main view", onClick: () => host.adoptTask(detail.taskId, project, detail.workflow) });
  return verbs;
}

/**
 * The panel beside a conversation (a `chat` entry): its tabs — what the conversation produced, what it
 * changed, and what has been held out of it — and its head's words. Shared by `panelFaces.tsx` and the
 * universal Chat room (decision 0015).
 */
export function chatTabs(held: number): PanelTabSpec[] {
  return [tab("produced", "Produced"), tab("changes", "Changes"), tab("held", "Held", held > 0 ? { count: held } : {})];
}
export const chatPanelTitleOf = (detail: TaskDetail | null): string => detail?.title ?? "This conversation";
export const CHAT_PANEL_SUB = "beside the conversation";

/**
 * The Steps index's two verbs on a step (its right-click menu): rewind to before the step was entered,
 * or fork there — the cut at the journal position of the step's `entered` turn. Absent when the host
 * cannot do both; a step with no `entered` turn offers nothing to cut at.
 */
export function indexCutOf(
  turns: readonly { kind: string; instanceId?: string | undefined; seq: number }[] | undefined,
  taskId: string,
  onRewind: ((taskId: string, seq: number) => void) | undefined,
  onFork: ((taskId: string, seq: number) => void) | undefined,
): { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined {
  if (onRewind === undefined || onFork === undefined) return undefined;
  const seqOf = (node: InstanceNode): number | undefined => turns?.find((turn) => turn.kind === "entered" && turn.instanceId === node.instanceId)?.seq;
  return {
    rewind: (node: InstanceNode) => {
      const seq = seqOf(node);
      if (seq !== undefined) onRewind(taskId, seq);
    },
    fork: (node: InstanceNode) => {
      const seq = seqOf(node);
      if (seq !== undefined) onFork(taskId, seq);
    },
  };
}
