import { createContext, type ReactNode } from "react";
import type { WorkflowOutcome } from "@jaira/shared/browser";
import type { NestHandle } from "../chat/StartedTaskLine";

/**
 * Who draws what a workflow tool DID, under its call (`OutcomeNote`): the host the transcript is in,
 * when it has more to say than the note. The Chat view answers for a run its conversation started — the
 * run's own line, and the run nested under it (`ChildRunLine`); anything it returns `undefined` for, and
 * every host that provides nothing, gets the plain note.
 */
export const OutcomeHostContext = createContext<((outcome: WorkflowOutcome) => ReactNode | undefined) | undefined>(undefined);

/**
 * Who draws a task a `start_task` call made of its own (decision 0029 §2), under the call: the Chat view
 * answers with the task's line — what it waits for, or works on, or how it stopped — and the task nested
 * under it (`StartedTaskLine`, decision 0003's nest). A host that provides nothing draws the call alone.
 */
export const StartedTaskHostContext = createContext<((taskId: string, nest: NestHandle) => ReactNode | undefined) | undefined>(undefined);
