/**
 * What needs the person, as the desktop tells it OUTSIDE its window (the person, 2026-11-26: "at the OS
 * level, so a notification or perhaps an icon on the taskbar"; chosen from the OS-attention mockups:
 * 1 actionable toasts, 2 a badge on the taskbar button, 3 the button's progress bar and flash).
 *
 * Pure: the engine's pushes in, a ledger of what is open and what has not been looked at, and what the
 * taskbar and a toast should say. Electron stays in `attentionDesktop.ts`.
 *
 *   asking     an approval, an agent's question, or a gate other than a conversation's `input()` —
 *              open until its `*:resolved`; counted on the badge, toasted with its answers as buttons
 *   replied    a conversation that answered and now waits at `input()` for the next message — toasted
 *              (with a reply box) only when this process saw it work since it last waited, so a start
 *              that re-parks every conversation says nothing
 *   failed     a run that ended `failed` — toasted, and the badge's "!" until the window is looked at
 *   done       a run that ended `completed` — the badge's tick until the window is looked at, no toast
 */
import type { PendingApproval, PendingInteraction, PendingQuestion, PushMessage } from "@jaira/shared";

/** A conversation's wait for its next message (the engine's `INPUT_FUNCTION`): not a question. */
export const INPUT_COMPONENT = "input";

export type AttentionKind = "asking" | "replied" | "failed" | "done";

/** One thing to tell the person about. */
export type AttentionItem =
  | { kind: "asking"; requestId: string; taskId: string | undefined; project: string; ask: Ask; recovered: boolean }
  | { kind: "replied"; requestId: string; taskId: string; project: string }
  | { kind: "failed" | "done"; taskId: string; project: string | undefined };

export type Ask =
  | { type: "question"; pending: PendingQuestion }
  | { type: "approval"; pending: PendingApproval }
  | { type: "gate"; pending: PendingInteraction };

/** The open asks, what ended since the window was last looked at, and which conversations are working. */
export class AttentionLedger {
  readonly asking = new Map<string, Extract<AttentionItem, { kind: "asking" }>>();
  readonly failed = new Set<string>();
  readonly done = new Set<string>();
  /** Conversations seen producing a turn since they last waited — a later `input()` is a reply. */
  private readonly working = new Set<string>();

  /**
   * Take one push: what it adds that the person should be TOLD of (a toast), or undefined. A push that
   * only changes counts (a resolve, a completion, a recovered ask) returns undefined after changing them.
   */
  take(message: PushMessage): AttentionItem | undefined {
    switch (message.type) {
      case "session:turn":
        this.working.add(message.taskId);
        return undefined;
      case "question:requested":
        return this.ask({ type: "question", pending: message.pending }, message.pending.requestId, message.pending.taskId, message.pending.project, message.pending.recovered === true);
      case "approval:requested":
        return this.ask({ type: "approval", pending: message.pending }, message.pending.requestId, message.pending.taskId, message.pending.project, message.pending.recovered === true);
      case "interaction:requested": {
        const pending = message.pending;
        if (pending.component === INPUT_COMPONENT) {
          if (!this.working.delete(pending.taskId)) return undefined;
          return { kind: "replied", requestId: pending.requestId, taskId: pending.taskId, project: pending.project };
        }
        // Another machine's gate read while it is offline is not one to ring for here.
        return this.ask({ type: "gate", pending }, pending.requestId, pending.taskId, pending.project, pending.offline !== undefined);
      }
      case "question:resolved":
      case "approval:resolved":
      case "interaction:resolved":
        this.asking.delete(message.requestId);
        return undefined;
      case "run:finished":
        this.working.delete(message.taskId);
        if (message.status === "failed") {
          this.failed.add(message.taskId);
          return { kind: "failed", taskId: message.taskId, project: message.project };
        }
        if (message.status === "completed") this.done.add(message.taskId);
        return undefined;
      default:
        return undefined;
    }
  }

  /** The asks open when this process came to the engine (`*:pending`): counted, never toasted. */
  seed(questions: readonly PendingQuestion[], approvals: readonly PendingApproval[], gates: readonly PendingInteraction[]): void {
    for (const p of questions) this.ask({ type: "question", pending: p }, p.requestId, p.taskId, p.project, true);
    for (const p of approvals) this.ask({ type: "approval", pending: p }, p.requestId, p.taskId, p.project, true);
    for (const p of gates) if (p.component !== INPUT_COMPONENT) this.ask({ type: "gate", pending: p }, p.requestId, p.taskId, p.project, true);
  }

  /** The window was looked at: what ended is no longer news. Open asks stay until answered. */
  looked(): void {
    this.failed.clear();
    this.done.clear();
  }

  private ask(ask: Ask, requestId: string, taskId: string | undefined, project: string, recovered: boolean): AttentionItem | undefined {
    const item = { kind: "asking" as const, requestId, taskId, project, ask, recovered };
    this.asking.set(requestId, item);
    return recovered ? undefined : item;
  }
}

/** What the taskbar button shows. */
export interface TaskbarState {
  /** The overlay: a count of open asks, else "!" for a failure, else a tick, else none. */
  badge: { kind: "asking"; count: number } | { kind: "failed" } | { kind: "done" } | undefined;
  /** The bar under the button (`setProgressBar`): amber while something asks, red on a failure, moving while work runs. */
  progress: "paused" | "error" | "indeterminate" | "none";
  /** The badge's words, for the overlay's description (read by a screen reader). */
  description: string;
}

export function taskbarOf(ledger: Pick<AttentionLedger, "asking" | "failed" | "done">, working: boolean): TaskbarState {
  const asking = ledger.asking.size;
  const failed = ledger.failed.size;
  const done = ledger.done.size;
  const words = [asking > 0 ? `${asking} asking` : "", failed > 0 ? `${failed} failed` : "", done > 0 ? `${done} finished` : ""].filter((w) => w !== "");
  return {
    badge: asking > 0 ? { kind: "asking", count: asking } : failed > 0 ? { kind: "failed" } : done > 0 ? { kind: "done" } : undefined,
    progress: asking > 0 ? "paused" : failed > 0 ? "error" : working ? "indeterminate" : "none",
    description: words.length === 0 ? "" : `JaiRA: ${words.join(", ")}`,
  };
}

/** What a toast button does. */
export type ToastAnswer =
  | { channel: "question:submit"; request: { requestId: string; answers: Record<string, string> } }
  | { channel: "approval:submit"; request: { requestId: string; decision: "allow" | "deny"; scope: "once" } }
  | { open: true };

export interface ToastSpec {
  /** One toast per thing: a later one about the same thing replaces it (the toast's tag). */
  id: string;
  title: string;
  body: string;
  buttons: Array<{ text: string; answer: ToastAnswer }>;
  /** A reply box whose text goes to the conversation as its next message. */
  reply?: { taskId: string; project: string };
}

/** Windows shows at most five buttons; one is always Open. */
const MAX_CHOICES = 3;

/** The toast for one item, `title` being its task's name where known. */
export function toastOf(item: AttentionItem, title: string | undefined): ToastSpec {
  const name = title ?? "A task";
  const open = { text: "Open", answer: { open: true } as ToastAnswer };
  switch (item.kind) {
    case "asking": {
      const ask = item.ask;
      if (ask.type === "question") {
        const first = ask.pending.questions[0];
        const single = ask.pending.questions.length === 1 && first !== undefined && first.multiSelect !== true && first.options.length > 0 && first.options.length <= MAX_CHOICES;
        return {
          id: item.requestId,
          title: `${name} is asking`,
          body: clip(first?.question ?? "It has a question for you."),
          buttons: [
            ...(single ? first.options.map((o) => ({ text: o.label, answer: { channel: "question:submit" as const, request: { requestId: item.requestId, answers: { [first.question]: o.label } } } })) : []),
            open,
          ],
        };
      }
      if (ask.type === "approval") {
        const what = ask.pending.command ?? ask.pending.reason ?? ask.pending.tool;
        return {
          id: item.requestId,
          title: `${name} wants to use ${ask.pending.tool}`,
          body: clip(what),
          buttons: [
            { text: "Allow once", answer: { channel: "approval:submit", request: { requestId: item.requestId, decision: "allow", scope: "once" } } },
            { text: "Deny", answer: { channel: "approval:submit", request: { requestId: item.requestId, decision: "deny", scope: "once" } } },
            open,
          ],
        };
      }
      return { id: item.requestId, title: `${name} is waiting on you`, body: `It needs your input (${ask.pending.component}).`, buttons: [open] };
    }
    case "replied":
      return { id: item.requestId, title: `${name} replied`, body: "It is waiting for your next message.", buttons: [open], reply: { taskId: item.taskId, project: item.project } };
    case "failed":
      return { id: `failed:${item.taskId}`, title: `${name} failed`, body: "Open it to see what went wrong.", buttons: [open] };
    case "done":
      return { id: `done:${item.taskId}`, title: `${name} finished`, body: "", buttons: [open] };
  }
}

function clip(text: string, max = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
