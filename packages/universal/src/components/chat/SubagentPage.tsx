import { useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { ApprovalScope, PendingApproval, PendingInteraction, SessionView } from "@jaira/shared/browser";
import type { ApprovalAnswerExtras } from "@jaira/ui/approvalSurfaceTypes";
import { askDrawnAtItsCall } from "@jaira/ui/approvalCall";
import type { LiveTail } from "@jaira/ui/transcript";
import type { Subagent } from "@jaira/ui/subagentModel";
import { ApprovalAskContext } from "@jaira/ui/workSummaryContext";
import { CallGateContext } from "@jaira/ui/programCalls";
import { scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { InlineHost, useLiveEdge } from "../panel/RunTranscript";
import { GateSurface } from "../panel/Gate";
import { Transcript } from "../panel/SessionTranscript";
import { Paper } from "./Paper";

/**
 * A subagent of the conversation walked into: its conversation is the page, the way a run the
 * conversation started is when walked into (`childRunHost.tsx`). No composer of its own — the box still
 * talks to the conversation. The approval it asks for is drawn here, at its call where a summary draws it
 * (`askDrawnAtItsCall`), else under the page — and so is a question one of its tool calls put mid-call
 * (`git_push`'s publish question, `PendingInteraction.callId`); the subagents it started are its own lines (the host is
 * the Chat view's, provided around this page).
 *
 *   the whole          column, flex 1; the scroller flex 1, following the live edge
 *   the page           at least the scroller's height (`Paper`); its end left free for the pills
 */
export function SubagentPage({
  sub,
  session,
  live,
  approval,
  onApproval,
  gate,
  onGate,
  bottomInset,
}: {
  sub: Subagent;
  session: SessionView | null;
  live: LiveTail | null;
  /** The pending approval, when this subagent is the one asking. */
  approval?: PendingApproval | undefined;
  onApproval?: ((decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void) | undefined;
  /** The gate one of this subagent's tool calls asked, when it is the one asking. */
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  bottomInset: number;
}): JSX.Element {
  const t = useTokens();
  const { at: _at, following: _following, unpin: _unpin, ...follow } = useLiveEdge(sub.call);
  const [viewport, setViewport] = useState<number | undefined>(undefined);
  const ask = approval !== undefined && onApproval !== undefined ? { pending: approval, onDecide: onApproval } : undefined;
  const atItsCall = approval !== undefined && askDrawnAtItsCall(sub.entries, approval, sub.running);
  const asked = gate !== undefined && onGate !== undefined ? <GateSurface key={gate.requestId} pending={gate} onSubmit={onGate} plain /> : undefined;
  const gateAt = useMemo(() => (asked === undefined || gate?.callId === undefined ? undefined : (callId: string): ReactNode | undefined => (callId === gate.callId ? asked : undefined)), [asked, gate?.callId]);
  // Its call's row draws it; with no row to hold it, it is drawn under the page, never nowhere.
  const gateAtItsCall = gate?.callId !== undefined && sub.entries.some((entry) => entry.kind === "tool" && entry.callId === gate.callId);
  return (
    <View flex={1} minHeight={0} flexDirection="column">
      <ScrollView
        {...(scrollbarProps(t) as object)}
        style={{ flex: 1, minHeight: 0 }}
        {...follow}
        onLayout={(e) => {
          setViewport(e.nativeEvent.layout.height);
          follow.onLayout(e);
        }}
      >
        <ApprovalAskContext.Provider value={ask}>
          <CallGateContext.Provider value={gateAt}>
          <Paper minHeight={viewport}>
            <Transcript session={session} entries={sub.entries} live={live} working={sub.running} empty="This subagent has not said anything yet." agentRail />
            {ask !== undefined && !atItsCall ? (
              <InlineHost>
                <ApprovalSurface key={ask.pending.requestId} pending={ask.pending} onDecide={ask.onDecide} />
              </InlineHost>
            ) : null}
            {asked !== undefined && !gateAtItsCall ? <InlineHost>{asked}</InlineHost> : null}
          </Paper>
          </CallGateContext.Provider>
        </ApprovalAskContext.Provider>
        {bottomInset > 0 ? <View height={bottomInset} flexShrink={0} /> : null}
      </ScrollView>
    </View>
  );
}
