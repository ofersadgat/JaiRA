/**
 * A task a conversation STARTED of its own (decision 0029 §2), as its line under the call that started it
 * opens (the mockups of 2026-11-24, `docs/ui/assets/chat-view/child-asks-ways-in.html`). The person:
 * "1. if you click on the arrow or start task, it should open just that task inline by default 2. if you
 * click on "waiting for ...." it should open all tasks to reveal the dialog in question inline 3. if you
 * mouse over the waiting for ... there should be an inline open nested, open in window, open in split,
 * open in context panel which opens all tasks to reveal the dialog in the selected place 4. if you mouse
 * over the row there should be the same … but which only opens a single level."
 *
 * So what you point at decides how deep it opens: the line ONE level (its own run, the tasks it started
 * shut), its wait every task down to the one that asks (`deep`). Pure, so the rules can be tested.
 */
import { parentTaskOf, type ChildLink } from "@jaira/shared/browser";

/** How a started task's nest is open: shut, its own run only, or every task down to the question. */
export type NestMode = "shut" | "one" | "deep";

/** The nest's state, and who opened it: a nest a question opened shuts once it is answered. */
export interface NestState {
  mode: NestMode;
  by: "you" | "ask";
}

export const SHUT: NestState = { mode: "shut", by: "you" };

/** One thing asked of the person somewhere under a started task, itself included. */
export interface AskBelow {
  /** The task that asks. */
  taskId: string;
  /** The titles from under the started task down to the one that asks; empty when it asks itself. */
  path: string[];
  /** What is waited for, in words: the gate's function ("choose option"), "answer", "approve git push". */
  step: string;
  /** When it was asked, where the request says. */
  since?: number;
}

type Linked = ChildLink & { taskId: string; title?: string | undefined };

/** What the person is asked: a gate, an agent's question, a command approval — each with its task. */
export interface Asks {
  pending: ReadonlyArray<{ taskId: string; component: string; moves?: boolean | undefined }>;
  questions: ReadonlyArray<{ taskId?: string | undefined; at: number }>;
  approvals: ReadonlyArray<{ taskId?: string | undefined; at: number; tool: string; command?: string | undefined }>;
}

/** `choose_option` → "choose option". */
const wordsOf = (component: string): string => component.replace(/[_-]+/g, " ").trim();

/**
 * Every ask under `taskId` — its own and every task's it started, at any depth — the oldest first. A
 * conversation idle at its `input()` asks nobody anything (decision 0029 §2), and a move's question is
 * drawn where the move asked it, so neither is one.
 */
export function asksBelow(taskId: string, tasks: readonly Linked[], asks: Asks): AskBelow[] {
  const children = new Map<string, Linked[]>();
  for (const task of tasks) {
    const parent = parentTaskOf(task);
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [task]);
    else list.push(task);
  }
  // Each task under it, with the titles down to it — cycle-safe.
  const pathOf = new Map<string, string[]>([[taskId, []]]);
  const queue = [taskId];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const child of children.get(at) ?? []) {
      if (pathOf.has(child.taskId)) continue;
      pathOf.set(child.taskId, [...pathOf.get(at)!, child.title ?? child.taskId]);
      queue.push(child.taskId);
    }
  }
  const out: AskBelow[] = [];
  for (const gate of asks.pending) {
    if (gate.component === "input" || gate.moves === true) continue;
    const path = pathOf.get(gate.taskId);
    if (path !== undefined) out.push({ taskId: gate.taskId, path, step: wordsOf(gate.component) });
  }
  for (const question of asks.questions) {
    const path = question.taskId !== undefined ? pathOf.get(question.taskId) : undefined;
    if (path !== undefined) out.push({ taskId: question.taskId!, path, step: "answer", since: question.at });
  }
  for (const approval of asks.approvals) {
    const path = approval.taskId !== undefined ? pathOf.get(approval.taskId) : undefined;
    if (path !== undefined) out.push({ taskId: approval.taskId!, path, step: `approve ${approval.command?.split(/\s+/).slice(0, 2).join(" ") ?? approval.tool}`, since: approval.at });
  }
  return out.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

/** A press on the line (the arrow, its words, the `start task` row): its own run here, or shut again. */
export function toggledOne(was: NestState): NestState {
  return was.mode === "shut" ? { mode: "one", by: "you" } : SHUT;
}

/** A press on its wait: every task down to the question, here — or, open so already, shut again. */
export function toggledDeep(was: NestState): NestState {
  return was.mode === "deep" ? SHUT : { mode: "deep", by: "you" };
}

/**
 * What the asks under it moving does to the nest. A new question opens it down to the question — as a
 * press on its wait would — when the task is shown nowhere else; the last one answered shuts a nest a
 * question opened, and leaves one the person opened as it is.
 */
export function nestAfterAsks(was: NestState, before: number, now: number, elsewhere: boolean): NestState {
  if (before === 0 && now > 0 && !elsewhere && was.mode === "shut") return { mode: "deep", by: "ask" };
  if (before > 0 && now === 0 && was.by === "ask") return SHUT;
  return was;
}

