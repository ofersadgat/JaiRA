/**
 * What an approval surface is handed, and what its answer may carry beside the yes or the no — the props
 * `ApprovalSurface` and the approval dialogs take (`packages/universal/src/components/floats/`).
 * Types only, so a module that passes them along imports no component.
 */
import type { ApprovalScope, PartAnswer, PendingApproval, WritableLayer } from "@jaira/shared/browser";

/**
 * What rides beside the scope: the part widths to remember, and the layer to write them into — or, once
 * the rows were answered one by one (decision 0023 ruling 7), each row's own answer, and nothing else.
 */
export interface ApprovalAnswerExtras {
  remember?: string[];
  addTo?: WritableLayer;
  answers?: PartAnswer[];
}

export interface ApprovalSurfaceProps {
  pending: PendingApproval;
  error?: string | null;
  onDecide: (decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void;
  /** Draw with this answer's menu open — for a still picture of it (the gallery, a mockup). */
  initialMenu?: "allow" | "deny";
  /** Draw with this row's panel open (its part's index) — for a still picture of it. */
  initialRow?: number;
}
