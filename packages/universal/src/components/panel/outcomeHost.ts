import { createContext, type ReactNode } from "react";
import type { WorkflowOutcome } from "@jaira/shared/browser";

/**
 * Who draws what a workflow tool DID, under its call (`OutcomeNote`): the host the transcript is in,
 * when it has more to say than the note. The Chat view answers for a run its conversation started — the
 * run's own line, and the run nested under it (`ChildRunLine`); anything it returns `undefined` for, and
 * every host that provides nothing, gets the plain note.
 */
export const OutcomeHostContext = createContext<((outcome: WorkflowOutcome) => ReactNode | undefined) | undefined>(undefined);
