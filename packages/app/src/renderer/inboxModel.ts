import type { PendingApproval, PendingInteraction, PendingQuestion } from "@jaira/shared/browser";
import type { SidebarView } from "./sidebarTypes";

/**
 * The Inbox (decision 0015, amended 2026-10-04): everything awaiting the person, across projects, as a
 * room of its own beside All tasks and All conversations — what the desktop's inbox strip shows three of
 * (`InboxStrip.tsx`), all of it. Questions first, then command approvals, then workflow gates, in the
 * strip's order: an agent's loop is blocked until its question or approval is answered, a gate is a
 * state politely waiting.
 */
export type InboxKind = "question" | "approval" | "gate";

export interface InboxItem {
  key: string;
  kind: InboxKind;
  /** What it asks, in a few words: the heading of its card. */
  heading: string;
  /** What it is about: the question, the command, the gate's prompt. */
  text: string;
  /** More of it, where there is more: the other questions, the approval's reason. */
  detail?: string | undefined;
  taskId: string | undefined;
  project: string;
}

/** The Inbox's row in the sidebar, at the root beside All tasks and All conversations. */
export const INBOX_VIEW: SidebarView = { id: "inbox", glyph: "⏸", label: "Inbox", keepsProject: true };

export function inboxItemsOf(inbox: { pending: readonly PendingInteraction[]; approvals: readonly PendingApproval[]; questions: readonly PendingQuestion[] }): InboxItem[] {
  return [
    ...inbox.questions.map((item): InboxItem => ({
      key: item.requestId,
      kind: "question",
      heading: item.questions.length > 1 ? `The agent has ${item.questions.length} questions` : "The agent has a question",
      text: item.questions[0]?.question ?? "the agent has a question",
      detail: item.questions.length > 1 ? item.questions.slice(1).map((q) => q.question).join(" · ") : undefined,
      taskId: item.taskId,
      project: item.project,
    })),
    ...inbox.approvals.map((item): InboxItem => ({
      key: item.requestId,
      kind: "approval",
      heading: "Approve this command?",
      text: item.command ?? item.tool,
      detail: item.reason ?? undefined,
      taskId: item.taskId,
      project: item.project,
    })),
    ...inbox.pending.map((item): InboxItem => ({
      key: item.requestId,
      kind: "gate",
      heading: gateHeading(item.component),
      text: item.config?.prompt ?? item.component,
      taskId: item.taskId as string | undefined,
      project: item.project,
    })),
  ];
}

/** A gate's kind, as its card's heading says it. */
function gateHeading(component: string): string {
  switch (component) {
    case "choose_option":
      return "Choose one";
    case "confirm_action":
      return "Confirm";
    case "fill_form":
      return "Fill in a form";
    case "review_artifact":
    case "review_artifacts":
      return "Review";
    case "edit_artifact":
      return "Edit";
    case "approve_tool_call":
      return "Approve a tool call";
    default:
      return "Waiting for you";
  }
}
