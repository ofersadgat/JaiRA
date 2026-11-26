import { useEffect, useMemo, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { approvalCallIndex, askDrawnAtItsCall } from "@jaira/ui/approvalCall";
import { sessionKey } from "@jaira/ui/sessionCache";
import { sidechainWorkingOf, writingOf } from "@jaira/ui/stillRunning";
import { sidechainEntriesOf } from "@jaira/ui/transcript";
import { nodeAt, type TrailStep } from "@jaira/ui/trail";
import { AgentPage, AgentTranscript } from "../chat/AgentPage";
import { Paper } from "../chat/Paper";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { GateSurface } from "../panel/Gate";
import { Empty, InlineHost, type TranscriptSource } from "../panel/RunTranscript";

/**
 * A subagent's conversation, read off its host's session — a subagent of a task's run (the Tasks room's
 * walk, a leaf's panel, the side panel), or of a run a conversation started. The host instance's session
 * is fetched as any panel's is, the chain behind `step.sidechain` read the way the main thread is
 * (`sidechainEntriesOf`), the turns still streaming appended from the live tail. It is drawn as every
 * agent's conversation is (`AgentPage`, `AgentTranscript`): a subagent's page is a conversation's page.
 * What it asks is drawn on it — the task's agent's approval when its call is this subagent's (at that call
 * where a summary draws it, `askDrawnAtItsCall`, else under the page), a gate one of its calls asked under
 * that call's row. Doorways inside it walk deeper (`onOpen`, else the trail's `onWalkIntoSidechain`).
 *
 *   the whole          column, flex 1; the page flex 1
 */
export function SidechainConversation({
  step,
  detail,
  source,
  onOpen,
  gate,
  onGate,
}: {
  /** The sidechain step being stood on. `step.sidechain` is set — that is what makes it one. */
  step: TrailStep;
  detail: TaskDetail | null;
  /** What the page reads, and the task's agent's approval (`approval`, `onApproval`). */
  source: Pick<TranscriptSource, "sessions" | "onLoadSessions" | "liveTurn" | "onWalkIntoSidechain" | "approval" | "onApproval">;
  /** Where a nested doorway goes. Defaults to the trail (`onWalkIntoSidechain`). */
  onOpen?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
  /** A question one of the task's tool calls asked mid-call (`PendingInteraction.callId`): drawn under that call's row when the call is this subagent's. */
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
}): JSX.Element {
  const { sessions, onLoadSessions, liveTurn } = source;
  const call = step.sidechain ?? "";
  const view = sessions[step.instanceId] ?? null;
  // The host node, for pushing nested steps — and the honest answer when it is gone.
  const host = nodeAt(detail?.instances ?? [], step.instanceId);
  const open = onOpen ?? source.onWalkIntoSidechain;

  useEffect(() => {
    // A sidechain's host is a node of the folded tree, so it carries the run it came from.
    const at = { instanceId: step.instanceId };
    if (sessions[sessionKey(at)] === undefined) onLoadSessions([at]);
  }, [sessions, step.instanceId, host, onLoadSessions]);

  const liveItems = liveTurn?.sidechains[call];
  const liveChains = liveTurn?.sidechains;
  const entries = useMemo(() => sidechainEntriesOf(view, call, liveItems, liveChains), [view, call, liveItems, liveChains]);
  // Still being written exactly while the call that spawned it is still running (`stillRunning.ts`):
  // the host's record going on after the subagent answered does not make the subagent's last step live.
  const working = useMemo(() => {
    // The turn in flight is the host's when it streams this chain, or names the host's record.
    const hosts = liveTurn !== null && (liveItems !== undefined || (view !== null && liveTurn.sessionId === view.sessionId && liveTurn.seq === view.seq));
    return sidechainWorkingOf(view, call, hosts ? liveTurn : null, writingOf(undefined, view) || liveItems !== undefined);
  }, [view, call, liveTurn, liveItems]);
  // The asks that are this subagent's: an approval of a call of its own, a gate one of its calls asked.
  const { approval, onApproval } = source;
  const ask = approval !== undefined && onApproval !== undefined && approvalCallIndex(entries, approval.requestId) >= 0 ? { pending: approval, onDecide: onApproval } : undefined;
  const atItsCall = ask !== undefined && askDrawnAtItsCall(entries, ask.pending, working);
  const gateCall = gate?.callId;
  const asked = gate !== undefined && onGate !== undefined && gateCall !== undefined && entries.some((entry) => entry.kind === "tool" && entry.callId === gateCall) ? gate : undefined;
  const gateAt = useMemo(
    () => (asked === undefined || onGate === undefined ? undefined : (callId: string): ReactNode | undefined => (callId === asked.callId ? <GateSurface key={asked.requestId} pending={asked} onSubmit={onGate} plain /> : undefined)),
    [asked, onGate],
  );

  if (step.sidechain === undefined) return <Empty>This step is not a subagent conversation.</Empty>;
  if (view === null && liveItems === undefined) return <Empty>Loading…</Empty>;
  return (
    <View flex={1} minHeight={0} flexDirection="column">
      <AgentPage page={`${step.instanceId}:${call}`} grew={[view, liveItems]} ask={atItsCall ? ask : undefined} gateAt={gateAt}>
        {(viewport) => (
          <Paper minHeight={viewport}>
            <AgentTranscript
              session={view}
              entries={entries}
              live={liveTurn}
              working={working}
              empty="This subagent has not said anything yet."
              scope={`${detail?.taskId ?? ""}:${call}`}
              {...(open !== undefined && host !== undefined ? { onOpenSidechain: (nested: string, name: string) => open(host, nested, name) } : {})}
            />
            {ask !== undefined && !atItsCall ? (
              <InlineHost>
                <ApprovalSurface key={ask.pending.requestId} pending={ask.pending} onDecide={ask.onDecide} />
              </InlineHost>
            ) : null}
          </Paper>
        )}
      </AgentPage>
    </View>
  );
}
