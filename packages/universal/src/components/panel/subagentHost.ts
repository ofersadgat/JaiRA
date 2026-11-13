import { createContext, type ReactNode } from "react";

/**
 * Who draws a subagent under the call that started it, in place of the plain fold (`SidechainDoor`): the
 * host the transcript is in, when it has more to say. The Chat view answers with a run's line
 * (`ChildRunLine`): go in, what it is doing, and its conversation opened in place — the way a run the
 * conversation started is drawn (`OutcomeHostContext`). `undefined` from the host, or no host, is the fold.
 */
export const SubagentHostContext = createContext<((call: string) => ReactNode | undefined) | undefined>(undefined);
