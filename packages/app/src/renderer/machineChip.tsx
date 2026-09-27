/**
 * Where something runs (decision 0013 §4): a machine's name, with a dot for its state — filled when it is
 * online, hollow when it is offline, amber when it cannot share work with this one, dashed when there is
 * no machine yet (a queued task).
 */
import type { JSX } from "react";

export type MachineChipState = "on" | "off" | "warn" | "none";

export function MachineChip({ label, state = "on", title }: { label: string; state?: MachineChipState; title?: string }): JSX.Element {
  return (
    <span className={`chip mchip mchip-${state}`} title={title ?? label}>
      <i className="mchip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A peer's connection state as a chip's. */
export function chipStateOf(state: "online" | "offline" | "connecting" | "mismatch"): MachineChipState {
  return state === "online" ? "on" : state === "mismatch" ? "warn" : "off";
}
