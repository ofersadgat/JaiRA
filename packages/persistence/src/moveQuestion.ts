/**
 * The INPUT QUESTION a move parks in the task's own conversation (decision 0005, the rulings of
 * 2026-09-22, 2) — its durable half.
 *
 * A legal move whose target lacks required inputs does not wait on a separate conversation, and no
 * model asks for them in words: the host parks a QUESTION in the task's conversation, drawn with the
 * gate UI and filled through the one schema form, and answering it takes the move with the values
 * recorded `asked`. Two writes make it durable, one for each thing that has to survive a restart:
 *
 *  - the GATE — a `pending_interactions` row (`fill_form` over the inputs' own declared schemas), which
 *    is what every gate list, the inbox and the conversation already read, so it is offered again after
 *    a restart exactly as a parked gate is;
 *  - the MOVE — a `jaira.moveAsked` row in the task's journal, saying what move the answer takes and
 *    where in the task's history it was asked. `jaira.moveAnswered` closes it.
 *
 * The request id carries `MOVE_QUESTION_PREFIX`, so the one reader that only has an id — an answer
 * arriving through `interaction:submit` — knows it is the host's to act on and not a run's.
 */
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import {
  MOVE_ANSWERED_EVENT,
  MOVE_ASKED_EVENT,
  MOVE_QUESTION_PREFIX,
  moveQuestionPrompt,
  moveQuestionSchema,
  type MoveAnsweredEvent,
  type MoveAskedEvent,
} from "@jaira/shared";
import type { MoveQuestion } from "./connect";
import type { Project } from "./project";

/** A fresh id for a move's question — the prefix, then something no other gate uses. */
export function moveQuestionId(nowMs = Date.now()): string {
  return `${MOVE_QUESTION_PREFIX}${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The gate a move question is drawn as: its inputs are the `fill_form` contract. */
export function moveQuestionInputs(title: string, targetLabel: string, missing: MoveAskedEvent["missing"], optional: readonly MoveAskedEvent["missing"][number][] = []): Record<string, JsonValue> {
  return { prompt: moveQuestionPrompt(title, targetLabel, missing), schema: moveQuestionSchema(missing, optional) as JsonValue };
}

/** Park the question: the gate row, then the journal row that says what answering it does. */
export function parkMoveQuestion(project: Project, question: MoveQuestion, requestId: string, nowMs = Date.now()): MoveAskedEvent {
  project.interactions.open({
    requestId,
    taskId: question.taskId,
    component: "fill_form",
    inputs: moveQuestionInputs(question.title, question.targetLabel, question.missing, question.optional),
    createdAt: nowMs,
  });
  const row: MoveAskedEvent = {
    type: MOVE_ASKED_EVENT,
    requestId,
    move: question.move,
    missing: question.missing,
    ...(question.optional.length > 0 ? { optional: question.optional } : {}),
    targetLabel: question.targetLabel,
  };
  project.events.recorder(question.taskId).record(row as unknown as EngineEvent, nowMs);
  return row;
}

/** An open move question: its gate row is still there, and its journal says what move it holds. */
export interface OpenMoveQuestion {
  taskId: string;
  asked: MoveAskedEvent;
}

/**
 * The move question `requestId` names, while it is still open — its gate row unanswered and its
 * `jaira.moveAsked` row not cut away (a rewind past it takes the question with it).
 */
export function openMoveQuestion(project: Project, requestId: string): OpenMoveQuestion | undefined {
  const gate = project.interactions.get(requestId);
  if (gate === undefined) return undefined;
  let asked: MoveAskedEvent | undefined;
  for (const stored of project.events.list(gate.taskId)) {
    const event = stored.event as { type: string; requestId?: string };
    if (event.requestId !== requestId) continue;
    if (event.type === MOVE_ASKED_EVENT) asked = stored.event as unknown as MoveAskedEvent;
    else if (event.type === MOVE_ANSWERED_EVENT) asked = undefined;
  }
  return asked !== undefined ? { taskId: gate.taskId, asked } : undefined;
}

/**
 * Close the question: the gate row goes, and the journal says how it ended — the move taken with what
 * was answered, the move refused when it came to be taken, or the question dismissed.
 */
export function closeMoveQuestion(
  project: Project,
  taskId: string,
  requestId: string,
  outcome: MoveAnsweredEvent["outcome"],
  detail: { answered?: Record<string, JsonValue>; message?: string } = {},
  nowMs = Date.now(),
): void {
  project.interactions.close(requestId);
  const row: MoveAnsweredEvent = {
    type: MOVE_ANSWERED_EVENT,
    requestId,
    outcome,
    ...(detail.answered !== undefined ? { answered: detail.answered } : {}),
    ...(detail.message !== undefined ? { message: detail.message } : {}),
  };
  project.events.recorder(taskId).record(row as unknown as EngineEvent, nowMs);
}

/** The questions a task's journal says are still open, oldest first — each only while its gate row stands. */
export function openMoveQuestionsOf(project: Project, taskId: string): MoveAskedEvent[] {
  const open = new Map<string, MoveAskedEvent>();
  for (const stored of project.events.list(taskId)) {
    const event = stored.event as { type: string; requestId?: string };
    if (event.type === MOVE_ASKED_EVENT) open.set(event.requestId!, stored.event as unknown as MoveAskedEvent);
    else if (event.type === MOVE_ANSWERED_EVENT) open.delete(event.requestId!);
  }
  return [...open.values()].filter((asked) => project.interactions.get(asked.requestId) !== undefined);
}
