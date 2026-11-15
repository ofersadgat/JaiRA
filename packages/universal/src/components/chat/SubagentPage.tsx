import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { ApprovalScope, PendingApproval, SessionView } from "@jaira/shared/browser";
import type { ApprovalAnswerExtras } from "@jaira/ui/approvalSurfaceTypes";
import { askDrawnAtItsCall } from "@jaira/ui/approvalCall";
import type { LiveTail } from "@jaira/ui/transcript";
import type { Subagent } from "@jaira/ui/subagentModel";
import { ApprovalAskContext } from "@jaira/ui/workSummaryContext";
import { scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { InlineHost, useLiveEdge } from "../panel/RunTranscript";
import { Transcript } from "../panel/SessionTranscript";
import { Paper } from "./Paper";

/**
 * A subagent of the conversation walked into: its conversation is the page, the way a run the
 * conversation started is when walked into (`childRunHost.tsx`). No composer of its own — the box still
 * talks to the conversation. The approval it asks for is drawn here, at its call where a summary draws it
 * (`askDrawnAtItsCall`), else under the page; the subagents it started are its own lines (the host is
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
  bottomInset,
}: {
  sub: Subagent;
  session: SessionView | null;
  live: LiveTail | null;
  /** The pending approval, when this subagent is the one asking. */
  approval?: PendingApproval | undefined;
  onApproval?: ((decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void) | undefined;
  bottomInset: number;
}): JSX.Element {
  const t = useTokens();
  const { at: _at, following: _following, unpin: _unpin, ...follow } = useLiveEdge(sub.call);
  const [viewport, setViewport] = useState<number | undefined>(undefined);
  const ask = approval !== undefined && onApproval !== undefined ? { pending: approval, onDecide: onApproval } : undefined;
  const atItsCall = approval !== undefined && askDrawnAtItsCall(sub.entries, approval, sub.running);
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
          <Paper minHeight={viewport}>
            <Transcript session={session} entries={sub.entries} live={live} working={sub.running} empty="This subagent has not said anything yet." agentRail />
            {ask !== undefined && !atItsCall ? (
              <InlineHost>
                <ApprovalSurface key={ask.pending.requestId} pending={ask.pending} onDecide={ask.onDecide} />
              </InlineHost>
            ) : null}
          </Paper>
        </ApprovalAskContext.Provider>
        {bottomInset > 0 ? <View height={bottomInset} flexShrink={0} /> : null}
      </ScrollView>
    </View>
  );
}
