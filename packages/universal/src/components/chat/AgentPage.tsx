import { useEffect, useRef, useState, type JSX, type MutableRefObject, type ReactNode } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { InstanceNode, SessionView } from "@jaira/shared/browser";
import { ApprovalAskContext, type ApprovalAsk } from "@jaira/ui/workSummaryContext";
import { CallGateContext, CallInterruptContext } from "@jaira/ui/programCalls";
import type { LiveTail, TranscriptEntry } from "@jaira/ui/transcript";
import type { ArtifactSurface, EditMessage } from "@jaira/ui/transcriptViewTypes";
import { PLAIN_SCROLLER, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Transcript } from "../panel/SessionTranscript";
import { DayChip } from "../panel/TranscriptMarks";
import { OutcomeHostContext, StartedTaskHostContext } from "../panel/outcomeHost";
import { SubagentHostContext } from "../panel/subagentHost";
import { AgentHostContext } from "../panel/AgentRail";
import { ScrollWindowProvider, useScrollWindow } from "../Virtual";
import { EDGE_START, UP_KEYS, dragging, pressed, readerUp, repin, resized, scrolled, settled, type EdgeState } from "./liveEdge";
import { useStepBookmarks } from "./stepBookmarks";
import type { useChildRunHost } from "./childRunHost";

/** What a page's rows reach for — the lines of the runs, tasks and subagents its agent started, and its rail. */
export type AgentPageHosts = Partial<Pick<ReturnType<typeof useChildRunHost>, "outcomeHost" | "startedHost" | "subagentHost" | "agentHost">>;

const NO_ENTRIES: readonly TranscriptEntry[] = [];

/**
 * An agent's work as a page — the ONE way an agent's conversation is drawn, whichever agent it is (a
 * conversation's own, or a subagent it started, however deep) and wherever it stands (the main view, a
 * split's pane, the side panel; the person, 2026-11-25: "a subagent should render the same way a normal
 * agent renders … no matter where it appears"). The scroller that follows the live edge while the reader
 * is on it, the day over it (web), the steps it marks, what is drawn far above deferred until it comes
 * near, and the hosts its rows reach for; what is ON the page is `children` (`AgentTranscript` on a
 * `Paper`, with what the host adds around it). How it looks:
 *
 *   the scroller     flex 1, scrolls, follows the live edge while the reader is on it (`liveEdge.ts`)
 *   the day          a chip floating over the page, sticky, 0 tall (`DayChip`, web)
 *   the end          `pillSpace` left free under the page, where the pills over the box would cover it
 *
 * `page` names what the page is of: another one opens at its end. `grew` is what, read again, grows it
 * (the thread, the live tail): followed while pinned.
 */
export function AgentPage({
  page,
  grew,
  ask,
  gateAt,
  interrupt,
  hosts,
  pillSpace = 0,
  steps,
  jumpRef,
  onAway,
  children,
}: {
  page: string;
  grew: readonly unknown[];
  /** The approval asked at its call's row (`askDrawnAtItsCall`); asked anywhere else, the host draws it on the page. */
  ask?: ApprovalAsk | undefined;
  /** A gate a call asked, under that call's row. */
  gateAt?: ((callId: string) => ReactNode | undefined) | undefined;
  /** Interrupting one call of the program. */
  interrupt?: ((instanceId: string) => void) | undefined;
  hosts?: AgentPageHosts | undefined;
  pillSpace?: number | undefined;
  /** The steps marked on the page (`useStepBookmarks`): the run's root, what is on the page, a step to go to, where the reader is. */
  steps?: { root: InstanceNode | undefined; entries: readonly TranscriptEntry[]; focus?: { instance: string; at: number } | undefined; onHere?: ((instance: string | undefined, onScreen?: ReadonlySet<string>) => void) | undefined } | undefined;
  /** Where the host's "to the live edge" is handed (a send, a pill's jump). */
  jumpRef?: MutableRefObject<() => void> | undefined;
  /** The reader let go of the live edge, or came back to it. */
  onAway?: ((away: boolean) => void) | undefined;
  /** What is on the page, given the scroller's height (the sheet is at least that tall). */
  children: (viewport: number | undefined) => ReactNode;
}): JSX.Element {
  const t = useTokens();
  const scroller = useRef<ScrollView | null>(null);
  // What a phone keeps drawn of the page: what shows and three screens either side (`Virtual`).
  const scrollWindow = useScrollWindow(scroller);
  /** Whether the reader is pinned to the live edge, and what lets go of it (`liveEdge.ts`). */
  const edge = useRef<EdgeState>(EDGE_START);
  const away = useRef(false);
  const tellAway = useRef(onAway);
  tellAway.current = onAway;
  const [viewport, setViewport] = useState<number | undefined>(undefined);
  const settle = (next: EdgeState): void => {
    edge.current = next;
    if (away.current !== !next.pinned) {
      away.current = !next.pinned;
      tellAway.current?.(away.current);
    }
  };
  const toEnd = (): void => {
    // To the very end: `scrollToEnd` stops a fraction short on web.
    scroller.current?.scrollTo({ y: 1e9, animated: false });
    scrollWindow.atEnd();
  };
  const jump = (): void => {
    settle(repin(edge.current));
    toEnd();
  };
  if (jumpRef !== undefined) jumpRef.current = jump;
  // Another page opens at its end.
  useEffect(() => {
    settle(repin(edge.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  useEffect(() => {
    if (edge.current.pinned) toEnd();
    const settleTimer = setTimeout(() => {
      // Which day the page stands on once it has settled where it opened: a page opened at its end, that
      // nothing then scrolls or grows, had no day over it (2026-11-13, two panes on one conversation drew
      // the chip in one and not the other).
      if (isWeb) readDay();
    }, 400);
    return () => clearTimeout(settleTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...grew, page]);
  // Which day the reader is looking at (`DayChip`): the last message whose top has passed under the
  // chip, read off the `data-day` stamps the messages carry (web), and whether the page is moving.
  const [day, setDay] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readDay = (): void => {
    const box = (scroller.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
    if (box === null || box === undefined || typeof box.querySelectorAll !== "function") return;
    const top = box.getBoundingClientRect().top;
    let found: string | null = null;
    const stamped = Array.from(box.querySelectorAll<HTMLElement>("[data-day]"));
    for (const node of stamped) {
      if (node.getBoundingClientRect().top - top > 30) break;
      found = node.dataset["day"] ?? found;
    }
    // None passed under the chip yet: the day of the first one under it — a function of where the page
    // stands alone, not of where it stood before.
    if (found === null) found = stamped[0]?.dataset["day"] ?? null;
    setDay((was) => (was === found ? was : (found ?? was)));
  };
  useEffect(() => () => {
    if (idle.current !== null) clearTimeout(idle.current);
  }, []);
  const marks = useStepBookmarks(scroller, steps?.root, steps?.entries ?? NO_ENTRIES, steps?.focus, steps?.onHere, () => settle(readerUp(edge.current)), () => edge.current.pinned, String(t.v("accent")));
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (isWeb) {
      setMoving(true);
      readDay();
      marks.track();
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = setTimeout(() => setMoving(false), 900);
    }
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollWindow.scrolled(contentOffset.y);
    settle(scrolled(edge.current, { y: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height }, Date.now()));
  };
  // What only the reader does (web): a wheel or a key upward lets go at once, before the scroll it makes
  // is reported (a word arriving in between would otherwise be followed back down); a drag of the
  // scrollbar or a finger makes the scrolls up during it the reader's; a press on something on the page
  // that can be pressed may unfold it (`resized`).
  useEffect(() => {
    if (!isWeb) return;
    const node = (scroller.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
    if (node === null || node === undefined || typeof node.addEventListener !== "function") return;
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0 && node.scrollTop > 0) settle(readerUp(edge.current));
    };
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if ((UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) && node.scrollTop > 0) settle(readerUp(edge.current));
    };
    const onDown = (e: PointerEvent): void => {
      // The scroller itself under the pointer is its scrollbar.
      if (e.target === node) edge.current = dragging(edge.current, true, Date.now());
      else if (e.target instanceof Element) {
        const hit = e.target.closest('button, a, [role="button"], [tabindex]');
        if (hit !== null && hit !== node && node.contains(hit)) edge.current = pressed(edge.current, Date.now());
      }
    };
    const onTouch = (): void => {
      edge.current = dragging(edge.current, true, Date.now());
    };
    const onRelease = (): void => {
      if (edge.current.drivingUntil === Infinity) edge.current = dragging(edge.current, false, Date.now());
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("keydown", onKey);
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("touchstart", onTouch, { passive: true });
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("touchend", onRelease);
    window.addEventListener("touchcancel", onRelease);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("touchstart", onTouch);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("touchend", onRelease);
      window.removeEventListener("touchcancel", onRelease);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ScrollView
      ref={scroller}
      {...(scrollbarProps(t) as object)}
      style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
      contentContainerStyle={{ flexDirection: "column", flexGrow: 1, ...PLAIN_SCROLLER } as never}
      onLayout={(e) => {
        setViewport(e.nativeEvent.layout.height);
        scrollWindow.sized(e.nativeEvent.layout.height);
        // A viewport that shrank (the composer grew a line, a wait came over the box) keeps the end.
        if (edge.current.pinned) toEnd();
      }}
      onScroll={onScroll}
      scrollEventThrottle={32}
      // A phone's drag and fling (web reads its own events above).
      onScrollBeginDrag={() => {
        edge.current = dragging(edge.current, true, Date.now());
      }}
      onScrollEndDrag={() => {
        edge.current = dragging(edge.current, false, Date.now());
      }}
      onMomentumScrollEnd={() => {
        edge.current = settled(edge.current);
      }}
      // Follow the live edge while pinned to it: everything that grows the page, but a row the reader
      // just opened (`resized`).
      onContentSizeChange={(width, height) => {
        // Whatever grew moved what is under it: a phone measures its pieces again (`Virtual`).
        scrollWindow.moved(width, height);
        const { state, follow } = resized(edge.current, height, Date.now());
        settle(state);
        if (follow) toEnd();
        if (isWeb) {
          readDay();
          marks.track();
        }
      }}
    >
      <ScrollWindowProvider window={scrollWindow.window}>
        {/* Which day you are reading, floating over the page (sticky, 0 tall). */}
        {isWeb ? <DayChip day={day} moving={moving} /> : null}
        <OutcomeHostContext.Provider value={hosts?.outcomeHost}>
          <StartedTaskHostContext.Provider value={hosts?.startedHost}>
            <SubagentHostContext.Provider value={hosts?.subagentHost}>
              <AgentHostContext.Provider value={hosts?.agentHost}>
                <ApprovalAskContext.Provider value={ask}>
                  <CallInterruptContext.Provider value={interrupt}>
                    <CallGateContext.Provider value={gateAt}>{children(viewport)}</CallGateContext.Provider>
                  </CallInterruptContext.Provider>
                </ApprovalAskContext.Provider>
              </AgentHostContext.Provider>
            </SubagentHostContext.Provider>
          </StartedTaskHostContext.Provider>
        </OutcomeHostContext.Provider>
        {/* The end the pills over the box would cover, left free while they show. */}
        {pillSpace > 0 ? <View height={pillSpace} flexShrink={0} /> : null}
      </ScrollWindowProvider>
    </ScrollView>
  );
}

/**
 * An agent's conversation as the page draws it — the same rows for every agent: each message's rail and
 * its controls, the agents it started on a rail beside it, what is far above drawn as it comes near.
 * `scope` is what a reader's type corrections are kept under: the conversation's, or a subagent's own.
 */
export function AgentTranscript({
  session,
  entries,
  live,
  working,
  empty,
  artifacts,
  onEdit,
  scope,
  narrated,
  doomedFrom,
  onOpenSidechain,
}: {
  session: SessionView | null;
  entries: TranscriptEntry[];
  live?: LiveTail | null | undefined;
  working?: boolean | undefined;
  empty?: string | undefined;
  artifacts?: ArtifactSurface | undefined;
  onEdit?: EditMessage | undefined;
  scope?: string | undefined;
  narrated?: boolean | undefined;
  doomedFrom?: number | undefined;
  onOpenSidechain?: ((call: string, name: string) => void) | undefined;
}): JSX.Element {
  return (
    <Transcript
      session={session}
      entries={entries}
      {...(live !== undefined ? { live } : {})}
      {...(working !== undefined ? { working } : {})}
      {...(empty !== undefined ? { empty } : {})}
      {...(artifacts !== undefined ? { artifacts } : {})}
      {...(onEdit !== undefined ? { onEdit } : {})}
      {...(scope !== undefined ? { scope } : {})}
      {...(narrated === true ? { narrated: true } : {})}
      {...(doomedFrom !== undefined ? { doomedFrom } : {})}
      {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
      rails
      agentRail
      // Opened at its end: what is far above waits until it is scrolled near (web).
      deferFar
    />
  );
}
