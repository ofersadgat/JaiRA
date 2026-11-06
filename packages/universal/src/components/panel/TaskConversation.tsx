import { useMemo, useSyncExternalStore, type JSX } from "react";
import type { InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { hasAsking } from "@jaira/ui/stateSurfaceModel";
import { RunConversation } from "../run/RunConversation";
import { InlineGate } from "./Gate";
import type { TranscriptSource } from "./RunTranscript";

/**
 * A task's conversation in the panel: `RunConversation` (`components/run/RunConversation.tsx`) — the
 * transcript's scroller and what stands where the composer would, a column taking the body's height —
 * with the gate the task is parked on at the foot when the tree has no place for it. A subagent's
 * doorway walks into its conversation on the panel's own stack (`onOpenSidechain`), not the trail.
 */
export function TaskConversation({
  detail,
  project,
  source,
  gate,
  onGate,
  focus,
  onRerun,
  onResume,
  onOpenSidechain,
}: {
  detail: TaskDetail;
  project: string | undefined;
  source: TranscriptSource;
  gate: PendingInteraction | undefined;
  onGate: (value: unknown) => void;
  /** Where a click asked it to land — an event notice opens the events task at its firing (`landingFocusOf`). */
  focus?: { instance: string; at: number } | undefined;
  onRerun: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const hosted = gate !== undefined && detail.instances.some((node) => hasAsking(node));
  // The gate at the foot is at most 55% of the conversation's height. It stands in the box under the
  // scroller, where a percentage has nothing to resolve against, so the height is measured and handed
  // down — to the gate alone: kept as this component's state, every new height (a sheet being dragged)
  // drew the whole conversation again.
  const height = useMemo(() => measured(), []);
  const footed = gate !== undefined && !hosted;
  return (
    <RunConversation
      detail={detail}
      parent={detail.instances[0]}
      source={source}
      project={project}
      {...(gate !== undefined ? { gate, onGate } : {})}
      // A gate, the agent's question and its approval each hold the run WAITING, as in the run view.
      asking={gate !== undefined || source.approval !== undefined || source.question !== undefined}
      {...(focus !== undefined ? { focus } : {})}
      onRerun={onRerun}
      onResume={onResume}
      onOpenSidechain={onOpenSidechain}
      {...(footed ? { onLayout: height.set } : {})}
      foot={footed ? <FootGate height={height} pending={gate} onGate={onGate} services={source.gateServices} /> : null}
    />
  );
}

/** A measured height, and who to tell when it moves. */
interface Measured {
  get: () => number | undefined;
  set: (height: number) => void;
  subscribe: (listener: () => void) => () => void;
}

function measured(): Measured {
  let height: number | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => height,
    set: (next) => {
      if (next === height) return;
      height = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The gate at the foot, at most 55% of the conversation's measured height. */
function FootGate({ height, pending, onGate, services }: { height: Measured; pending: PendingInteraction; onGate: (value: unknown) => void; services: TranscriptSource["gateServices"] }): JSX.Element {
  const tall = useSyncExternalStore(height.subscribe, height.get, height.get);
  return <InlineGate pending={pending} onGate={onGate} services={services} {...(tall !== undefined ? { maxHeight: tall * 0.55 } : {})} />;
}
