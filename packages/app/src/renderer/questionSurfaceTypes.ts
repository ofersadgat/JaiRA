/**
 * What an agent's question is drawn from — the props the universal `QuestionSurface`
 * (`packages/universal/src/components/floats/QuestionSurface.tsx`) takes. A type only.
 */
import type { PendingQuestion } from "@jaira/shared/browser";

/**
 * A running agent's question — the SAME control as an authored gate, with the answer going
 * somewhere else (decision 0002).
 *
 * Nothing here is being authorized: the options are the agent's own words and the answer travels
 * back as its tool input, so the choices are labels rather than verdicts and a question is answered,
 * never approved.
 *
 * Dismissal is the one affordance a gate does not get. An agent continues either way — told to use
 * its own judgment — where a gate's state has declared outputs that must receive a value.
 */
export interface QuestionSurfaceProps {
  pending: PendingQuestion;
  error?: string | null;
  /** `undefined` dismisses: the agent is told to use its own judgment and continue. */
  onSubmit: (answers: Record<string, string | string[]> | undefined) => void;
}
