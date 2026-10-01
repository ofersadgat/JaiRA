/**
 * What an approval surface is handed, and what its answer may carry beside the yes or the no — the props
 * the universal `ApprovalSurface` and the approval dialogs take (`packages/universal/src/components/floats/`).
 * Types only, so a module that passes them along imports no component.
 */
import type { ApprovalScope, PendingApproval, WritableLayer } from "@jaira/shared/browser";

/** What rides beside the scope: the part widths to remember, and the layer to write them into. */
export interface ApprovalAnswerExtras {
  remember?: string[];
  addTo?: WritableLayer;
}

export interface ApprovalSurfaceProps {
  pending: PendingApproval;
  error?: string | null;
  onDecide: (decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void;
  /** Draw with this answer's menu open — for a still picture of it (the gallery, a mockup). */
  initialMenu?: "allow" | "deny";
}
