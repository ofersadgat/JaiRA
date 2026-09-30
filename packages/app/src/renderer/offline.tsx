/**
 * Another machine's task while that machine is offline (decision 0013 §6–7): what the conversation
 * shows is this machine's copy of it, and what a person answers waits for the machine.
 */
import type { JSX } from "react";
import { offlinePeerOf } from "./machinesModel";
import { ago, useMachines } from "./machinesPane";

/** The line at the foot of a conversation whose machine is away. Nothing for this machine's own. */
export function OfflineBanner({ project }: { project: string | undefined }): JSX.Element | null {
  const [view] = useMachines();
  const peer = offlinePeerOf(view, project);
  if (peer === undefined) return null;
  return (
    <div className="cx-doing">
      <div className="run-doing">
        <span className="ellip">
          {peer.label} is offline · {ago(peer.lastSeenAt)}. What it did until then is here.
        </span>
        <span className="grow" />
      </div>
    </div>
  );
}

/** Under a gate answered here for a machine that is offline: the answer waits, and can be taken back. */
export function PendingSend({ machine, onTakeBack }: { machine: string; onTakeBack: () => void }): JSX.Element {
  return (
    <div className="pending-send">
      <span className="pending-dot" aria-hidden="true" />
      <span className="grow">
        Your answer waits for <b>{machine}</b>, which is offline. It is delivered when {machine} reconnects.
      </span>
      <button type="button" className="ghost" onClick={onTakeBack}>
        Take it back
      </button>
    </div>
  );
}
