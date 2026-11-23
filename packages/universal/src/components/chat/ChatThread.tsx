import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { KEPT, armingText, replyPlaceholder, useChatThread } from "@jaira/ui/chatThreadModel";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { ApprovalAskContext } from "@jaira/ui/workSummaryContext";
import { routeDownOf, routeOf } from "@jaira/ui/composerModel";
import { keepLayersOf } from "@jaira/ui/composerCards";
import { facesOf } from "@jaira/ui/environmentModel";
import { placementSummaryOf } from "@jaira/ui/placementSummary";
import { clockOf } from "@jaira/ui/runActivityModel";
import { PLAIN_SCROLLER, Press, Txt, scrollbarProps } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Transcript } from "../panel/SessionTranscript";
import { CallInterruptContext, type ProgramCall } from "@jaira/ui/programCalls";
import { Composer, RouteFixes } from "./Composer";
import { useMentions } from "@jaira/ui/chatMentions";
import { LiveStatusLine, LiveStatusPill, Paper } from "./Paper";
import { useShell, useShellOrNull } from "../../app/shell";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { QuestionSurface } from "../floats/QuestionSurface";
import { InlineHost } from "../panel/RunTranscript";
import { ForkMark, OriginMark } from "../panel/SessionBands";
import { WaitingHost } from "./Waiting";
import { DayChip } from "../panel/TranscriptMarks";
import { FootFade } from "./FootFade";
import { EnvironmentBar } from "./EnvironmentBar";
import { PlacementSummary } from "./PlacementSummary";
import { QueuedMessage } from "./QueuedMessage";
import { Switch } from "../settings/controls";
import { useChatEnvironment } from "./environment";
import { useChildRunHost } from "./childRunHost";
import { OutcomeHostContext } from "../panel/outcomeHost";
import { SubagentHostContext } from "../panel/subagentHost";
import { AgentHostContext } from "../panel/AgentRail";
import { ScrollWindowProvider, useScrollWindow } from "../Virtual";
import { PictureSizesContext } from "../pictureSize";
import { EDGE_START, UP_KEYS, dragging, pressed, readerUp, repin, resized, scrolled, settled, type EdgeState } from "./liveEdge";
import { useStepBookmarks } from "./stepBookmarks";
import { SeenWhileShown } from "../../app/SeenWhileShown";

/**
 * One conversation: the thread on its sheet, the live status line, and the box under it. Everything it
 * holds and derives is `chatThreadModel.ts`'s `useChatThread`; this only draws it, and scrolls. How it
 * looks:
 *
 *   the thread       column, flex 1
 *   its scroller     flex 1, scrolls, follows the live edge while the reader is on it
 *   the foot         --bg, and an 18px fade into --bg over the thread's last pixels (`FootFade`), hung
 *                    from the top of all that stands under the thread, so it fades the thread alone
 *   what it is doing a pill first in the pills' row over the box, or the composer's first line
 *                    (`appearance.conversation.liveStatus`; `LiveStatusPill`, `LiveStatusLine`)
 *   what is armed    row, centred, gap 8, 900 at most, 8 above, padding 5 12, radius 8, --accent 10%
 *                    over transparent, app 12/12.5, --dim (a rewind: --bad's)
 *   an error         900 at most, 6 below, padding 6 12, radius 8, --bad 12% over transparent, --bad,
 *                    app 12/12.5
 *
 * With it: the approval and question asked inline (`InlineHost`), a message waiting for the allowance
 * (`Waiting.tsx`), a conversation that divided (`ForkMark`) or was forked from another (`OriginMark`),
 * and the day chip over the thread (`DayChip`, web — a phone draws none yet).
 *
 * Where it runs (decision 0013 §5): a conversation that was placed says how above its first message
 * (`PlacementSummary`), and its shell environment in the tray under the box (`EnvironmentBar`). One that
 * has not started — it is being placed, or waits for a workspace with room — is that summary in
 * progress and the message it will open with, not sent yet (`QueuedMessage`); the box takes no reply
 * then, and its chips change the start it waits for.
 */
export function ChatThread({
  surface,
  focus,
  onHere,
}: {
  surface: ChatSurface;
  /** A step to go to, picked in the Steps index beside the thread (a program read as its task); `at` changes on every pick. */
  focus?: { instance: string; at: number } | undefined;
  /** Where the reader is, as they scroll — the step being viewed, and every step on screen — for that index to mark. */
  onHere?: ((instance: string | undefined, onScreen?: ReadonlySet<string>) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const scroller = useRef<ScrollView | null>(null);
  // What a phone keeps drawn of the thread: what shows and three screens either side (`Virtual`).
  const scrollWindow = useScrollWindow(scroller);
  /** Whether the reader is pinned to the live edge, and what lets go of it (`liveEdge.ts`). */
  const edge = useRef<EdgeState>(EDGE_START);
  const [away, setAway] = useState(false);
  const [viewport, setViewport] = useState<number | undefined>(undefined);
  const settle = (next: EdgeState): void => {
    edge.current = next;
    setAway((was) => (was === !next.pinned ? was : !next.pinned));
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
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const m = useChatThread(surface, jumpRef);
  // The sizes the person gave its pictures: kept while the conversation is open, dropped when it is left.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pictureSizes = useMemo(() => new Map<string, number>(), [m.taskId]);
  /** The runs this conversation started: their lines, the one walked into, and the waits over the box. */
  // Where it says what the agent is doing: a pill over the thread's end, or the composer's first line.
  const { state: shell } = useShell();
  const place = useMemo(() => lookOf(shell.config).conversation.liveStatus, [shell.config]);
  const jumpIf = away ? { onJump: jump } : {};
  const live = surface.live ?? m.afterglow;
  const runs = useChildRunHost(surface, () => jumpRef.current(), m.status !== null && place === "pill" ? <LiveStatusPill status={m.status} {...jumpIf} /> : undefined, {
    session: m.thread?.session ?? null,
    entries: m.entries,
    live,
    answering: m.answering,
  });
  const mentions = useMentions(surface.hasProject, m.project);
  const env = useChatEnvironment(surface);
  const placement = placementSummaryOf({
    queued: m.queued,
    placed: surface.detail?.placed,
    starting: m.starting,
    agent: m.plan?.effective.model !== undefined && routeOf(m.plan.effective.model) !== "" ? routeOf(m.plan.effective.model) : undefined,
    selfId: env.view?.machines.find((machine) => machine.self)?.id,
  });
  const placed = placement !== undefined ? <PlacementSummary summary={placement} faces={facesOf(env.view)} clock={clockOf} /> : null;
  // Another conversation opens at its end.
  useEffect(() => {
    settle(repin(edge.current));
  }, [m.taskId]);
  useEffect(() => {
    if (edge.current.pinned) toEnd();
    const settleTimer = setTimeout(() => {
      // Which day the thread stands on once it has settled where it opened: a thread opened at its end,
      // that nothing then scrolls or grows, had no day over it (2026-11-13, two panes on one
      // conversation drew the chip in one and not the other).
      if (isWeb) readDay();
    }, 400);
    return () => clearTimeout(settleTimer);
  }, [m.thread, surface.live, m.taskId]);
  // Which day the reader is looking at (`DayChip`): the last message whose top has passed under the
  // chip, read off the `data-day` stamps the messages carry (web), and whether the thread is moving.
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
    // None passed under the chip yet: the day of the first one under it. What the chip says is then a
    // function of where the thread stands alone, not of where it stood before (two panes on one
    // conversation drew it in one and not the other, 2026-11-13).
    if (found === null) found = stamped[0]?.dataset["day"] ?? null;
    setDay((was) => (was === found ? was : (found ?? was)));
  };
  useEffect(() => () => {
    if (idle.current !== null) clearTimeout(idle.current);
  }, []);
  const steps = useStepBookmarks(scroller, surface.detail?.instances[0], m.entries, focus, onHere, () => settle(readerUp(edge.current)), () => edge.current.pinned, String(t.v("accent")));
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (isWeb) {
      setMoving(true);
      readDay();
      steps.track();
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = setTimeout(() => setMoving(false), 900);
    }
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollWindow.scrolled(contentOffset.y);
    settle(scrolled(edge.current, { y: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height }, Date.now()));
  };
  // What only the reader does (web): a wheel or a key upward lets go at once, before the scroll it
  // makes is reported (a word arriving in between would otherwise be followed back down); a drag of
  // the scrollbar or a finger makes the scrolls up during it the reader's; a press on something in the
  // thread that can be pressed may unfold it (`resized`).
  const walkedIn = runs.walkedIn !== null;
  useEffect(() => {
    if (!isWeb || walkedIn) return;
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
  }, [walkedIn]);
  const narrated = m.status !== null ? { narrated: true } : {};
  const doomed = m.doomedFrom !== undefined ? { doomedFrom: m.doomedFrom } : {};
  // What the agent is blocked on — the command it waits to run, the question it asked — drawn where the
  // turn is arriving, under what it said before asking. Keyed on the request.
  // A run the conversation started draws its own agent's asks in the run's page (`childRunHost.tsx`).
  const ownApproval = surface.approval !== undefined && surface.onApproval !== undefined && runs.ownApproval;
  const ownQuestion = surface.question !== undefined && surface.onQuestion !== undefined && runs.ownQuestion;
  const asking =
    (ownApproval && !m.approvalInThread) || ownQuestion ? (
      <>
        {ownApproval && !m.approvalInThread && surface.approval !== undefined ? (
          <InlineHost>
            <ApprovalSurface key={surface.approval.requestId} pending={surface.approval} onDecide={(decision, scope, extras) => surface.onApproval!(surface.approval!.requestId, decision, scope, extras)} />
          </InlineHost>
        ) : null}
        {ownQuestion && surface.question !== undefined ? (
          <InlineHost>
            <QuestionSurface key={surface.question.requestId} pending={surface.question} onSubmit={(answers) => surface.onQuestion!(surface.question!.requestId, answers)} />
          </InlineHost>
        ) : null}
      </>
    ) : null;
  const plain = m.split === null && (m.seam === null || m.seam.own.length === 0);
  return (
    <PictureSizesContext.Provider value={pictureSizes}>
    <View flex={1} minHeight={0} minWidth={0} flexDirection="column">
      {/* On screen is read: the task this conversation is, in every list at once. */}
      <SeenWhileShown taskId={surface.taskId} />
      {/* Walked into a run the conversation started: that run is the page, and nothing outside it. */}
      {runs.walkedIn !== null ? (
        <View flex={1} minHeight={0} flexDirection="column">
          {runs.walkedIn}
        </View>
      ) : (
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
        // Follow the live edge while pinned to it: everything that grows the thread, but a row the
        // reader just opened (`resized`).
        onContentSizeChange={(width, height) => {
          // Whatever grew moved what is under it: a phone measures its pieces again (`Virtual`).
          scrollWindow.moved(width, height);
          const { state, follow } = resized(edge.current, height, Date.now());
          settle(state);
          if (follow) toEnd();
          if (isWeb) {
            readDay();
            steps.track();
          }
        }}
      >
        <ScrollWindowProvider window={scrollWindow.window}>
        {/* Which day you are reading, floating over the thread (sticky, 0 tall). */}
        {isWeb ? <DayChip day={day} moving={moving} /> : null}
        <OutcomeHostContext.Provider value={runs.outcomeHost}>
        <SubagentHostContext.Provider value={runs.subagentHost}>
        <AgentHostContext.Provider value={runs.agentHost}>
        <ApprovalAskContext.Provider value={m.askValue}>
        <CallInterruptContext.Provider value={m.interruptCall}>
        <Paper minHeight={viewport}>
          {m.queued !== undefined ? (
            // Not started: the message it will open with, not sent until it has somewhere to run — in
            // the transcript's own column (padding 12 16 22).
            <View paddingTop={12} paddingHorizontal={16} paddingBottom={22} minWidth={0}>
              {placed}
              <QueuedMessage message={m.openingMessage ?? ""} since={m.queued.since} waiting={m.queued.phase === "waiting"} onEdit={m.takeBack} onDelete={() => surface.onDelete([m.taskId], m.project)} />
            </View>
          ) : placed !== null ? (
            // Over the transcript, in its column; the transcript's own 12 above is taken back.
            <View paddingTop={12} paddingHorizontal={16} marginBottom={-12} minWidth={0}>
              {placed}
            </View>
          ) : null}
          {m.queued !== undefined ? null : (
            <Transcript
              session={m.thread?.session ?? null}
              entries={m.split !== null ? m.split.shared : m.seam !== null ? m.seam.shared : m.entries}
              {...(plain ? { live, working: m.answering } : {})}
              empty={m.answering ? "Working…" : "This conversation has not said anything yet."}
              artifacts={m.artifacts}
              onEdit={m.edit}
              scope={m.taskId}
              rails
              agentRail
              {...narrated}
              {...doomed}
            />
          )}
          {m.queuedMessages.length > 0 ? (
            // Queued for the program's next `input()` (decision 0033 §9), in the transcript's column.
            <View paddingHorizontal={16} paddingBottom={12} minWidth={0}>
              {m.queuedMessages.map((item) => (
                <QueuedMessage
                  key={item.id}
                  about="reply"
                  message={item.text}
                  since={item.at}
                  waiting
                  onEdit={() => m.editQueued(item)}
                  onDelete={() => m.actOnQueued(item.id, "drop")}
                  {...(m.steerable ? { onSendNow: () => m.actOnQueued(item.id, "sendNow") } : {})}
                />
              ))}
            </View>
          ) : null}
          {plain ? asking : null}
        </Paper>
        {m.split === null && m.seam !== null && m.origin !== undefined ? (
          <>
            {/* Where this conversation came from — the same torn edge an edit's seam uses. */}
            <ChatFork>
              <OriginMark origin={m.origin} onGo={() => surface.onOpen(m.origin!.taskId, m.project)} />
            </ChatFork>
            {m.seam.own.length > 0 ? (
              <Paper minHeight={viewport}>
                <Transcript session={m.thread?.session ?? null} entries={m.seam.own} live={live} working={m.answering} artifacts={m.artifacts} onEdit={m.edit} scope={m.taskId} rails agentRail {...narrated} {...doomed} />
                {asking}
              </Paper>
            ) : null}
          </>
        ) : null}
        {m.split !== null && m.shown !== undefined ? (
          <>
            <ChatFork>
              <ForkMark sides={m.split.branches} shown={m.shown.key} onShow={m.setBranch} note="a message was replaced here" />
            </ChatFork>
            <Paper minHeight={viewport}>
              <Transcript
                session={m.thread?.session ?? null}
                entries={m.shown.entries}
                artifacts={m.artifacts}
                rails
                agentRail
                {...(m.shown.key === KEPT ? { live, working: m.answering, onEdit: m.edit } : {})}
                {...(m.status !== null && m.shown.key === KEPT ? { narrated: true } : {})}
                {...(m.shown.key === KEPT ? doomed : {})}
              />
              {m.shown.key === KEPT ? asking : null}
            </Paper>
          </>
        ) : null}
        </CallInterruptContext.Provider>
        </ApprovalAskContext.Provider>
        </AgentHostContext.Provider>
        </SubagentHostContext.Provider>
        </OutcomeHostContext.Provider>
        {/* The end the pills over the box would cover, left free while they show. */}
        {runs.pillSpace > 0 ? <View height={runs.pillSpace} flexShrink={0} /> : null}
        </ScrollWindowProvider>
      </ScrollView>
      )}

      {/* The box and what stands over it: the pills hang from the top of all of it, painted last. */}
      <View flexShrink={0} position="relative">
      {/* The thread fading into the ground the box sits on, over its last 18. */}
      <FootFade color={String(t.v("bg"))} />

      {m.waitingHere.length > 0 ? <WaitingHost items={m.waitingHere} /> : null}

      {/* Positioned: painted after the thread above it, with what else is. */}
      <View flexShrink={0} position="relative" backgroundColor={t.v("bg") as never}>
        {m.arming !== null ? (
          <View
            flexDirection="row"
            flexWrap="wrap"
            alignItems="center"
            columnGap={8}
            rowGap={4}
            width="100%"
            maxWidth={900}
            alignSelf="center"
            marginTop={8}
            paddingVertical={5}
            paddingHorizontal={12}
            borderRadius={8}
            backgroundColor={t.mix(t.v(m.arming.kind === "rewind" ? "bad" : "accent"), 10, "transparent") as never}
          >
            {/* A rewind's words wrap: over something still running they say what, and what each button does. */}
            <Txt
              spec={{ voice: "app", scale: 12 / 12.5, color: m.arming.kind === "rewind" ? "bad" : "dim" }}
              {...(m.arming.kind === "rewind" ? {} : { ellip: true })}
              flexGrow={1}
              flexShrink={1}
              flexBasis={240}
              minWidth={0}
            >
              {armingText(m.arming, m.arming.kind === "rewind" ? m.runningSaid : null, m.hasWorktree)}
            </Txt>
            <View flexDirection="row" alignItems="center" gap={8} marginLeft="auto">
              <Press onPress={m.disarm} paddingVertical={3} paddingHorizontal={10} borderRadius={7} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
                <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "text" }}>Cancel</Txt>
              </Press>
              {m.arming.kind !== "rewind" ? null : m.runningSaid === null && m.arming.waiting !== true ? (
                <Press onPress={() => m.confirmRewind("now")} paddingVertical={3} paddingHorizontal={10} borderRadius={7} backgroundColor={t.v("bad") as never}>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "panel" }}>Rewind</Txt>
                </Press>
              ) : (
                <>
                  {/* Waiting already, the wait is what Cancel ends; stopping is still on offer. */}
                  {m.arming.waiting === true ? null : (
                    <Press
                      onPress={() => m.confirmRewind("wait")}
                      paddingVertical={3}
                      paddingHorizontal={10}
                      borderRadius={7}
                      box={({ hovered }) => ({ backgroundColor: t.mix(t.v("bad"), hovered ? 22 : 14, "transparent") as never })}
                    >
                      <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "bad" }}>Wait for agents to finish</Txt>
                    </Press>
                  )}
                  <Press onPress={() => m.confirmRewind("stop")} paddingVertical={3} paddingHorizontal={10} borderRadius={7} backgroundColor={t.v("bad") as never}>
                    <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "panel" }}>Stop agents</Txt>
                  </Press>
                </>
              )}
            </View>
          </View>
        ) : null}
        {m.stepsOffered ? (
          // The program at the level of its calls, among its messages (decision 0033 §1): over the box, where
          // it stays in reach however far the thread has scrolled.
          <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8} width="100%" maxWidth={900} alignSelf="center" paddingHorizontal={12} paddingTop={6}>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>Every step</Txt>
            <Switch on={m.everyStep} label="Every step" onChange={m.setEveryStep} />
          </View>
        ) : null}
        {m.error !== null ? <ChatError text={m.error} route={m.errorRoute} /> : null}
        {m.choosing !== null ? (
          <InterruptChoices calls={m.runningCalls} withMessage={m.choosing.withMessage} onPick={(call) => m.interrupt(call, m.choosing!.withMessage)} onCancel={m.cancelChoosing} />
        ) : m.answering && m.runningCalls.length > 0 && m.draft.trim() !== "" ? (
          <InterruptOffer onInterrupt={m.interruptWithMessage} />
        ) : null}
        <Composer
          plan={m.queued !== undefined ? m.startPlan : (m.plan ?? null)}
          busy={m.sending > 0 || m.answering}
          joinable={m.thread !== null}
          overrides={m.queued !== undefined ? m.queuedSettings : m.overrides}
          // Waiting, a chip changes the start it waits for; while it is being placed, nothing can.
          onOverrides={m.queued === undefined ? m.setOverrides : m.queued.phase === "waiting" ? surface.onQueuedSettings : () => undefined}
          value={m.draft}
          onValue={m.setDraft}
          onSend={m.send}
          onStop={m.stop}
          placeholder={replyPlaceholder(m.arming)}
          {...(m.queued !== undefined
            ? { disabled: m.queued.phase === "waiting" ? "This conversation starts when a workspace has room." : "Finding somewhere for this conversation to run…" }
            : m.plan === null && m.thread === null
              ? { disabled: "This conversation cannot be continued." }
              : {})}
          tray={<EnvironmentBar view={env.view} stage={env.stage} onChoose={env.onChoose} automatic={env.automatic} asking={surface.taskId ?? undefined} />}
          head={m.status !== null && place === "composer" && runs.walkedIn === null ? <LiveStatusLine status={m.status} {...jumpIf} /> : undefined}
          usage={{ context: m.lastContext, total: m.contextTotal, onCompact: m.onCompact, cost: m.thread?.costUsd }}
          stack={{ project: m.project, ...(surface.taskId !== null ? { taskId: surface.taskId } : {}) }}
          saveLayers={keepLayersOf(surface.hasProject)}
          {...mentions}
        />
      </View>
      {runs.pills}
      </View>
    </View>
    </PictureSizesContext.Provider>
  );
}

/** What went wrong, over the box. */
export function ChatError({ text, route }: { text: string; route?: string | undefined }): JSX.Element {
  const t = useTokens();
  // While the route the message went to is still down, what fixes it is offered here too.
  const down = routeDownOf(route, useShellOrNull()?.state.probes);
  return (
    <View width="100%" maxWidth={900} alignSelf="center" marginBottom={6} paddingVertical={6} paddingHorizontal={12} borderRadius={8} backgroundColor={t.mix(t.v("bad"), 12, "transparent") as never} flexDirection="row" alignItems="center" flexWrap="wrap" gap={8} role="alert">
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "bad" }} flexGrow={1} flexShrink={1} flexBasis={240} minWidth={0}>
        {text}
      </Txt>
      {down !== undefined ? <RouteFixes down={down} /> : null}
    </View>
  );
}

/** A mark between two pages of the thread — the page's width, 900 at most, centred. */
function ChatFork({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View width="100%" maxWidth={900} alignSelf="center">
      {children}
    </View>
  );
}


/**
 * Which call to interrupt, asked when a program has several going (decision 0033 §7): one button each,
 * named by its title or its label, and "All of them".
 *
 *   the strip     row, wrapping, centred, gap 8 4, at most 900 wide, centred, 8 above, padding 5 12,
 *                 radius 8, --bad 10% over transparent; the question app 12/12.5 --bad
 *   a call        padding 3 10, radius 7, 1px --line, app 12/12.5 --text (hovered --fill-ghost-hover)
 */
function InterruptChoices({ calls, withMessage, onPick, onCancel }: { calls: readonly ProgramCall[]; withMessage: boolean; onPick: (call: ProgramCall | null) => void; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const choice = (key: string, label: string, onPress: () => void, title?: string): JSX.Element => (
    <Press key={key} onPress={onPress} {...(title !== undefined ? { title } : {})} paddingVertical={3} paddingHorizontal={10} borderRadius={7} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "text" }} numberOfLines={1}>
        {label}
      </Txt>
    </Press>
  );
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={8} rowGap={4} width="100%" maxWidth={900} alignSelf="center" marginTop={8} paddingVertical={5} paddingHorizontal={12} borderRadius={8} backgroundColor={t.mix(t.v("bad"), 10, "transparent") as never}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "bad" }} flexShrink={1}>
        {withMessage ? "Interrupt which, with your message?" : "Interrupt which?"}
      </Txt>
      {calls.map((call) => choice(call.instanceId, call.label, () => onPick(call), call.fn))}
      {choice("all", "All of them", () => onPick(null))}
      <View marginLeft="auto">{choice("cancel", "Cancel", onCancel)}</View>
    </View>
  );
}

/** While a reply is being written and the box holds a message: interrupt it, the message its reason. */
function InterruptOffer({ onInterrupt }: { onInterrupt: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" justifyContent="flex-end" width="100%" maxWidth={900} alignSelf="center" marginTop={6} paddingHorizontal={12}>
      <Press onPress={onInterrupt} title="Stop the reply being written, and send this — the program takes it next" paddingVertical={3} paddingHorizontal={10} borderRadius={7} box={({ hovered }) => ({ backgroundColor: t.mix(t.v("bad"), hovered ? 22 : 12, "transparent") as never })}>
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "bad" }}>Interrupt with this message</Txt>
      </Press>
    </View>
  );
}
