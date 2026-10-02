import { useEffect, useMemo, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { InstanceNode, TaskDetail } from "@jaira/shared/browser";
import { sessionKey } from "@jaira/ui/sessionCache";
import { sidechainWorkingOf, writingOf } from "@jaira/ui/stillRunning";
import { sidechainEntriesOf } from "@jaira/ui/transcript";
import { nodeAt, type TrailStep } from "@jaira/ui/trail";
import { scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Paper } from "../chat/Paper";
import { Empty, useLiveEdge, type TranscriptSource } from "../panel/RunTranscript";
import { Transcript } from "../panel/SessionTranscript";

/**
 * A subagent's conversation as a page of its own — what a sidechain step at the end of the walk shows,
 * and the panel's subagent entry. The host instance's session is fetched as any panel's is, the chain
 * behind `step.sidechain` read the way the main thread is (`sidechainEntriesOf`), the turns still
 * streaming appended from the live tail, and the page follows its live edge. No composer: it is
 * somebody else's conversation. Doorways inside it walk deeper (`onOpen`, else the trail's
 * `onWalkIntoSidechain`).
 *
 *   the whole          column, flex 1; the scroller flex 1
 *   the page           at least the scroller's height, padding 14 16 22, --bg, the sheet on it (`Paper`)
 */
export function SidechainConversation({
  step,
  detail,
  source,
  onOpen,
}: {
  /** The sidechain step being stood on. `step.sidechain` is set — that is what makes it one. */
  step: TrailStep;
  detail: TaskDetail | null;
  source: Pick<TranscriptSource, "sessions" | "onLoadSessions" | "liveTurn" | "onWalkIntoSidechain">;
  /** Where a nested doorway goes. Defaults to the trail (`onWalkIntoSidechain`). */
  onOpen?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
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
  const entries = useMemo(() => sidechainEntriesOf(view, call, liveItems), [view, call, liveItems]);
  // Still being written exactly while the call that spawned it is still running (`stillRunning.ts`):
  // the host's record going on after the subagent answered does not make the subagent's last step live.
  const working = useMemo(() => {
    // The turn in flight is the host's when it streams this chain, or names the host's record.
    const hosts = liveTurn !== null && (liveItems !== undefined || (view !== null && liveTurn.sessionId === view.sessionId && liveTurn.seq === view.seq));
    return sidechainWorkingOf(view, call, hosts ? liveTurn : null, writingOf(undefined, view) || liveItems !== undefined);
  }, [view, call, liveTurn, liveItems]);
  // Same rule as the thread that spawned it; the call is the reset — a different chain starts at its end.
  const { at: _at, following: _following, unpin: _unpin, ...follow } = useLiveEdge(call);
  // The page is at least as tall as the scroller: the scroller's own height, measured.
  const [viewport, setViewport] = useState<number | undefined>(undefined);

  if (step.sidechain === undefined) return <Empty>This step is not a subagent conversation.</Empty>;
  if (view === null && liveItems === undefined) return <Empty>Loading…</Empty>;
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
        <Paper minHeight={viewport}>
          <Transcript
            session={view}
            entries={entries}
            live={liveTurn}
            working={working}
            empty="This subagent has not said anything yet."
            {...(open !== undefined && host !== undefined ? { onOpenSidechain: (nested: string, name: string) => open(host, nested, name) } : {})}
          />
        </Paper>
      </ScrollView>
    </View>
  );
}
