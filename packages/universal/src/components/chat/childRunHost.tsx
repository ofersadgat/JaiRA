import { useMemo, useState, type ReactNode } from "react";
import type { InstanceNode, WorkflowOutcome } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { childRunFor, childRunsOf, keysTo, runningStepOf, scopedWaits, stepsIn, waitsOf, type RunWait } from "@jaira/ui/childRunModel";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { useRunContext } from "../run/runContext";
import { OutcomeHostContext } from "../panel/outcomeHost";
import { RunTranscript, type TranscriptSource } from "../panel/RunTranscript";
import { ChildRunLine, WaitPills, WAIT_PILLS_HEIGHT } from "./ChildRun";

/** "9:37 PM": when a wait began, on a pill. */
const shortClock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const keyOf = (run: InstanceNode): string => run.childKey ?? run.stateId;
const live = (run: InstanceNode): boolean => run.endedAt === undefined && (run.status === "running" || run.status === "waiting_for_user" || run.status === "blocked");

function idsIn(node: InstanceNode): string[] {
  return [node.instanceId, ...node.children.flatMap(idsIn)];
}

/**
 * The runs a conversation started (`start_task`, decision 0005), wired into the Chat view: the line each
 * call left and the run nested under it (`outcomeHost`), the run walked into as the main view
 * (`walkedIn`), and the pills over the box that say what is waited for from where you stand (`pills`).
 *
 * A run's conversation is read from what the selected task already holds (`useRunContext`) cut to the
 * run: its own sessions and journal turns, so the run's page does not also draw the conversation's
 * turns as pieces of its own. The agent's approval or question is the run's when its instance is in the
 * run — drawn in the run's page — and the conversation's otherwise, drawn where the thread asks it.
 */
export function useChildRunHost(surface: ChatSurface, jump: () => void): {
  outcomeHost: ((outcome: WorkflowOutcome) => ReactNode | undefined) | undefined;
  walkedIn: ReactNode | null;
  pills: ReactNode | null;
  /** What the thread leaves free at its end so the pills cover none of it. */
  pillSpace: number;
  /** Whether the agent's approval, and its question, are the conversation's (so the thread draws them). */
  ownApproval: boolean;
  ownQuestion: boolean;
} {
  const context = useRunContext();
  const detail = surface.detail;
  const instances = detail?.instances;
  const runs = useMemo(() => childRunsOf(instances), [instances]);
  const waits = useMemo(() => waitsOf({ instances, gate: surface.gate, approval: surface.approval, question: surface.question }), [instances, surface.gate, surface.approval, surface.question]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<{ instance: string; at: number } | undefined>(undefined);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string> | undefined>(undefined);
  const now = useNow(runs.some(live));
  const walked = surface.walkedInto !== undefined ? runs.find((run) => run.instanceId === surface.walkedInto) : undefined;
  const scope = walked !== undefined ? [keyOf(walked)] : [];

  /** Whose the agent's ask is: a run's, by its instance, or the conversation's. */
  const askRun = (instanceId: string | undefined): InstanceNode | undefined => (instanceId === undefined ? undefined : runs.find((run) => keysTo([run], instanceId) !== undefined));
  const approvalRun = askRun(surface.approval?.instanceId);
  const questionRun = askRun(surface.question?.instanceId);

  /** A run's conversation, cut to the run, with the gate it asks and the agent asks that are its own. */
  const sourceOf = (run: InstanceNode): TranscriptSource => {
    const mine = new Set(idsIn(run));
    return {
      ...context,
      sessionHistory: context.sessionHistory.filter((ref) => mine.has(ref.instanceId)),
      conversation: context.conversation === null ? null : { ...context.conversation, turns: context.conversation.turns.filter((turn) => turn.instanceId === undefined || mine.has(turn.instanceId)) },
      ...(surface.project !== null ? { project: surface.project } : {}),
      ...(approvalRun?.instanceId === run.instanceId && surface.approval !== undefined && surface.onApproval !== undefined
        ? { approval: surface.approval, onApproval: (decision, scope, extras) => surface.onApproval!(surface.approval!.requestId, decision, scope, extras) }
        : {}),
      ...(questionRun?.instanceId === run.instanceId && surface.question !== undefined && surface.onQuestion !== undefined
        ? { question: surface.question, onQuestion: (answers) => surface.onQuestion!(surface.question!.requestId, answers) }
        : {}),
    } as TranscriptSource;
  };
  const gate = surface.gate !== undefined && surface.onGate !== undefined ? { gate: surface.gate, onGate: (value: unknown) => surface.onGate!(surface.gate!.requestId, value) } : {};
  const took = (run: InstanceNode): string => `${secondsOf(Math.max(0, (run.endedAt ?? now) - run.startedAt))}${live(run) ? " so far" : ""}`;

  /** A press on a pill: the conversation's own wait is in its thread; a run's is in the run, at its step. */
  const go = (wait: RunWait): void => {
    const run = askRun(wait.instanceId);
    if (run === undefined) {
      surface.onWalkInto(null);
      setTimeout(jump, 50);
      return;
    }
    if (surface.walkedInto !== run.instanceId) surface.onWalkInto(run.instanceId);
    setFocus({ instance: wait.instanceId, at: Date.now() });
  };

  const outcomeHost =
    detail === null || runs.length === 0
      ? undefined
      : (outcome: WorkflowOutcome): ReactNode | undefined => {
          const run = childRunFor(instances, outcome);
          if (run === undefined) return undefined;
          const own = scopedWaits(waits, [keyOf(run)]);
          const step = own.length === 0 ? runningStepOf(run) : undefined;
          const isOpen = open.has(run.instanceId);
          return (
            <ChildRunLine
              outcome={outcome}
              waits={own}
              running={step !== undefined ? { step: step.step, path: step.path.slice(1) } : undefined}
              steps={stepsIn(run)}
              took={took(run)}
              open={isOpen}
              onToggle={() =>
                setOpen((was) => {
                  const next = new Set(was);
                  if (next.has(run.instanceId)) next.delete(run.instanceId);
                  else next.add(run.instanceId);
                  return next;
                })
              }
              onWalkIn={() => surface.onWalkInto(run.instanceId)}
            >
              {isOpen ? (
                // A run inside the run answers for itself: the host's line is for the conversation's own calls.
                <OutcomeHostContext.Provider value={undefined}>
                  <RunTranscript detail={detail} parent={run} source={sourceOf(run)} {...gate} nested />
                </OutcomeHostContext.Provider>
              ) : null}
            </ChildRunLine>
          );
        };

  // What is waited for, from where you stand; while nothing is, the step a run in scope works on.
  const here = scopedWaits(waits, scope);
  const working = here.length === 0 ? (walked !== undefined ? [walked] : runs).filter(live).map((run) => ({ run, step: runningStepOf(run) })).find((one) => one.step !== undefined) : undefined;
  const running =
    working?.step !== undefined
      ? {
          step: working.step.step,
          path: working.step.path.slice(scope.length),
          took: secondsOf(Math.max(0, now - working.step.since)),
          onGo: () => {
            if (surface.walkedInto !== working.run.instanceId) surface.onWalkInto(working.run.instanceId);
            setFocus({ instance: working.step!.instanceId, at: Date.now() });
          },
        }
      : undefined;
  const showPills = here.length > 0 || running !== undefined;
  const pills = showPills ? <WaitPills waits={here} running={running} {...(walked !== undefined ? { onScreen } : {})} clock={shortClock} onGo={go} /> : null;

  const walkedIn =
    walked === undefined || detail === null ? null : (
      <OutcomeHostContext.Provider value={undefined}>
        <RunTranscript
          detail={detail}
          parent={walked}
          source={sourceOf(walked)}
          {...gate}
          {...(focus !== undefined ? { focus } : {})}
          onHere={(_instance, seen) => setOnScreen(seen)}
          bottomInset={showPills ? WAIT_PILLS_HEIGHT : 0}
        />
      </OutcomeHostContext.Provider>
    );

  return { outcomeHost, walkedIn, pills, pillSpace: showPills ? WAIT_PILLS_HEIGHT : 0, ownApproval: approvalRun === undefined, ownQuestion: questionRun === undefined };
}
