import { useMemo, useState, type ReactNode } from "react";
import type { InstanceNode, SessionView, WorkflowOutcome } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { childRunFor, childRunsOf, keysTo, runningStepOf, scopedWaits, stepsIn, waitsOf, type RunWait } from "@jaira/ui/childRunModel";
import { chainScopedWaits, endedAgentsOf, subagentOfApproval, subagentsOf, withSubagentWaits, type Subagent } from "@jaira/ui/subagentModel";
import { sidechainEntriesOf, type LiveTail, type TranscriptEntry } from "@jaira/ui/transcript";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { useRunContext } from "../run/runContext";
import { OutcomeHostContext } from "../panel/outcomeHost";
import { RunTranscript, type TranscriptSource } from "../panel/RunTranscript";
import { SubagentHostContext } from "../panel/subagentHost";
import { Transcript } from "../panel/SessionTranscript";
import { ChildRunLine, WaitPills, WAIT_PILLS_HEIGHT } from "./ChildRun";
import { SubagentPage } from "./SubagentPage";
import { LIVE_PILL_HEIGHT } from "./Paper";

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
export function useChildRunHost(
  surface: ChatSurface,
  jump: () => void,
  /** The conversation's own status pill, first in the pills' row (`appearance.conversation.liveStatus`). */
  lead: ReactNode | undefined,
  /** The conversation's own thread: where its subagents are (`subagentModel.ts`). */
  thread: { session: SessionView | null; entries: readonly TranscriptEntry[]; live: LiveTail | null; answering: boolean },
): {
  outcomeHost: ((outcome: WorkflowOutcome) => ReactNode | undefined) | undefined;
  /** A subagent's line under the call that started it, the way a run's is drawn (`subagentHost.ts`). */
  subagentHost: ((call: string) => ReactNode | undefined) | undefined;
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
  // The subagents the conversation's agent started, nested ones too, and which one an approval is asked by.
  const { session: threadSession, entries: threadEntries, live: threadLive, answering } = thread;
  const subagents = useMemo(() => {
    const chains = threadLive?.sidechains;
    return subagentsOf({
      entries: threadEntries,
      chainOf: (call) => sidechainEntriesOf(threadSession, call, chains?.[call], chains),
      streaming: new Set(Object.keys(chains ?? {})),
      ended: endedAgentsOf(threadLive?.entries),
      answering,
    });
  }, [threadSession, threadEntries, threadLive, answering]);
  const approvalSub = subagentOfApproval(subagents, surface.approval?.requestId);
  const waits = useMemo(
    () => withSubagentWaits(waitsOf({ instances, gate: surface.gate, approval: surface.approval, question: surface.question }), approvalSub, subagents),
    [instances, surface.gate, surface.approval, surface.question, approvalSub, subagents],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<{ instance: string; at: number } | undefined>(undefined);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string> | undefined>(undefined);
  const now = useNow(runs.some(live) || [...subagents.values()].some((sub) => sub.running));
  const walked = surface.walkedInto !== undefined ? runs.find((run) => run.instanceId === surface.walkedInto) : undefined;
  const scope = walked !== undefined ? [keyOf(walked)] : [];
  // The subagent walked into, while every call of the chain is still one this conversation holds.
  const walkedChain = (surface.walkedChain ?? []).map((step) => step.call);
  const walkedSub = walkedChain.length > 0 && walkedChain.every((call) => subagents.has(call)) ? subagents.get(walkedChain[walkedChain.length - 1]!) : undefined;
  const walkInto = (sub: Subagent): void => surface.onWalkIntoSubagent(sub.chain.map((call) => ({ call, name: subagents.get(call)?.name ?? "subagent" })));
  const tookOf = (sub: Subagent): string =>
    sub.startedAt === undefined ? "" : `${secondsOf(Math.max(0, (sub.running ? now : (sub.lastAt ?? sub.startedAt)) - sub.startedAt))}${sub.running ? " so far" : ""}`;

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
    if (wait.chain !== undefined) {
      const sub = subagents.get(wait.chain[wait.chain.length - 1]!);
      if (sub !== undefined) walkInto(sub);
      return;
    }
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
              verb={outcome.verb}
              name={outcome.standsAt.split("/")[0] ?? outcome.standsAt}
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

  /** A subagent under the call that started it: a run's line, its conversation opened in place under it. */
  const subagentHost =
    subagents.size === 0
      ? undefined
      : (call: string): ReactNode | undefined => {
          const sub = subagents.get(call);
          if (sub === undefined) return undefined;
          const own = chainScopedWaits(waits, sub.chain);
          const isOpen = open.has(call);
          return (
            <ChildRunLine
              verb={sub.kind ?? "agent"}
              name={sub.name}
              goTitle={`make ${sub.name}'s conversation the main view`}
              waits={own}
              running={own.length === 0 && sub.step !== undefined ? { step: sub.step.step, path: sub.step.path } : undefined}
              steps={sub.steps}
              took={tookOf(sub)}
              open={isOpen}
              onToggle={() =>
                setOpen((was) => {
                  const next = new Set(was);
                  if (next.has(call)) next.delete(call);
                  else next.add(call);
                  return next;
                })
              }
              onWalkIn={() => walkInto(sub)}
            >
              {isOpen ? <Transcript session={threadSession} entries={sub.entries} live={threadLive} working={sub.running} /> : null}
            </ChildRunLine>
          );
        };

  // What is waited for, from where you stand; while nothing is, the step a run in scope works on — or,
  // walked into a subagent, the call it is on. A run's scope holds no subagent's wait, nor the reverse.
  const here = walkedSub !== undefined ? chainScopedWaits(waits, walkedSub.chain) : scopedWaits(walked !== undefined ? waits.filter((wait) => wait.chain === undefined) : waits, scope);
  const working = here.length === 0 && walkedSub === undefined ? (walked !== undefined ? [walked] : runs).filter(live).map((run) => ({ run, step: runningStepOf(run) })).find((one) => one.step !== undefined) : undefined;
  // A subagent at work, while nothing waits and no run does: the one walked into, else the newest at the top.
  const busySub =
    here.length === 0 && working === undefined && walked === undefined
      ? walkedSub !== undefined
        ? walkedSub.running
          ? walkedSub
          : undefined
        : [...subagents.values()].filter((sub) => sub.chain.length === 1 && sub.running).pop()
      : undefined;
  const subRunning =
    busySub?.step !== undefined
      ? {
          step: busySub.step.step,
          path: walkedSub !== undefined ? busySub.step.path : [busySub.name, ...busySub.step.path],
          took: tookOf(busySub),
          onGo: () => walkInto(busySub),
        }
      : undefined;
  const running =
    subRunning !== undefined
      ? subRunning
      : working?.step !== undefined
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
  // Walked into a run, the run is the page: the conversation's own status is not drawn over it. Nor
  // beside the conversation's own wait, which says the same with its time (`RunWait.own`).
  const leading = walked === undefined && walkedSub === undefined && lead !== undefined && lead !== null && !here.some((wait) => wait.own === true) ? lead : undefined;
  const pills =
    showPills || leading !== undefined ? <WaitPills lead={leading} waits={here} running={running} {...(walked !== undefined ? { onScreen } : {})} clock={shortClock} onGo={go} /> : null;

  const walkedIn =
    walkedSub !== undefined ? (
      <SubagentHostContext.Provider value={subagentHost}>
        <SubagentPage
          sub={walkedSub}
          session={threadSession}
          live={threadLive}
          {...(approvalSub?.call === walkedSub.call && surface.approval !== undefined && surface.onApproval !== undefined
            ? { approval: surface.approval, onApproval: (decision, how, extras) => surface.onApproval!(surface.approval!.requestId, decision, how, extras) }
            : {})}
          bottomInset={showPills ? WAIT_PILLS_HEIGHT : 0}
        />
      </SubagentHostContext.Provider>
    ) : walked === undefined || detail === null ? null : (
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

  return { outcomeHost, subagentHost, walkedIn, pills, pillSpace: showPills ? WAIT_PILLS_HEIGHT : leading !== undefined ? LIVE_PILL_HEIGHT : 0, ownApproval: approvalRun === undefined && approvalSub === undefined, ownQuestion: questionRun === undefined };
}
