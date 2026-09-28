import { useRef, useState, type JSX } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ChatSurface } from "@jaira/ui/chatPane";
import { KEPT, armingText, replyPlaceholder, useChatThread } from "@jaira/ui/chatThreadModel";
import { Uncopied } from "../../app/Uncopied";
import { Press, Txt, scrollbarProps } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Transcript } from "../panel/SessionTranscript";
import { Composer } from "./Composer";
import { LiveStatusBar, Paper, Sheet } from "./Paper";

/**
 * `chatPane.tsx`'s `ChatThread`, universal (decision 0015): one conversation — the thread on its sheet,
 * the live status line, and the box under it. Everything it holds and derives is `chatThreadModel.ts`'s
 * `useChatThread`, the hook the desktop's runs; this only draws it, and scrolls. The rules:
 *
 *   .chat-thread     column, flex 1
 *   .chat-scroll     flex 1, scrolls, follows the live edge while the reader is on it
 *   .chat-foot       --bg, and an 18px fade into --bg over the thread's last pixels (`::before`)
 *   .chat-editing    row, centred, gap 8, 900 at most, 8 above, padding 5 12, radius 8, --accent 10%
 *                    over transparent, app 12/12.5, --dim (.danger: --bad's)
 *   .cx-error        900 at most, 6 below, padding 6 12, radius 8, --bad 12% over transparent, --bad,
 *                    app 12/12.5
 *
 * {@link Uncopied}: the approval and question asked inline, a message waiting for the allowance, a
 * conversation that divided (the fork mark and its sides) or was forked from another (the origin seam),
 * and the day chip over the thread.
 */
export function ChatThread({ surface }: { surface: ChatSurface }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const scroller = useRef<ScrollView | null>(null);
  /** Whether the reader is at the live edge — `useStickToBottom`'s pin, on a native scroller. */
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const [viewport, setViewport] = useState<number | undefined>(undefined);
  const jump = (): void => {
    pinned.current = true;
    setAway(false);
    // To the very end: `scrollToEnd` stops a fraction short on web.
    scroller.current?.scrollTo({ y: 1e9, animated: false });
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const m = useChatThread(surface, jumpRef);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    // `nearBottom`'s rule: within 40px of the end is at it.
    const at = contentSize.height - contentOffset.y - layoutMeasurement.height < 40;
    pinned.current = at;
    setAway((was) => (was === !at ? was : !at));
  };
  const live = surface.live ?? m.afterglow;
  const narrated = m.status !== null ? { narrated: true } : {};
  const doomed = m.doomedFrom !== undefined ? { doomedFrom: m.doomedFrom } : {};
  const asking =
    (surface.approval !== undefined && surface.onApproval !== undefined && !m.approvalInThread) || (surface.question !== undefined && surface.onQuestion !== undefined) ? (
      <Uncopied name="the approval or question asked here" />
    ) : null;
  const plain = m.split === null && (m.seam === null || m.seam.own.length === 0);
  return (
    <View flex={1} minHeight={0} minWidth={0} flexDirection="column">
      <ScrollView
        ref={scroller}
        {...(scrollbarProps(t) as object)}
        style={{ flex: 1, minHeight: 0, ...(isWeb ? { transform: "none" } : {}) } as never}
        contentContainerStyle={{ flexDirection: "column", flexGrow: 1 }}
        onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
        onScroll={onScroll}
        scrollEventThrottle={32}
        // Follow the live edge while the reader is standing on it.
        onContentSizeChange={() => {
          if (pinned.current) scroller.current?.scrollTo({ y: 1e9, animated: false });
        }}
      >
        <Paper minHeight={viewport}>
          <Transcript
            session={m.thread?.session ?? null}
            entries={m.split !== null ? m.split.shared : m.seam !== null ? m.seam.shared : m.entries}
            {...(plain ? { live, working: m.answering } : {})}
            empty={m.answering ? "Working…" : "This conversation has not said anything yet."}
            onEdit={m.edit}
            scope={m.taskId}
            rails
            {...narrated}
            {...doomed}
          />
          {plain ? asking : null}
        </Paper>
        {m.split === null && m.seam !== null && m.origin !== undefined ? (
          <>
            <Uncopied name="the seam this conversation was forked at" />
            {m.seam.own.length > 0 ? (
              <View paddingHorizontal={16}>
                <Sheet dark={look.scheme === "dark"}>
                  <Transcript session={m.thread?.session ?? null} entries={m.seam.own} live={live} working={m.answering} onEdit={m.edit} scope={m.taskId} rails {...narrated} {...doomed} />
                  {asking}
                </Sheet>
              </View>
            ) : null}
          </>
        ) : null}
        {m.split !== null && m.shown !== undefined ? (
          <>
            <Uncopied name="the fork mark (a message was replaced here)" />
            <View paddingHorizontal={16}>
              <Sheet dark={look.scheme === "dark"}>
                <Transcript
                  session={m.thread?.session ?? null}
                  entries={m.shown.entries}
                  rails
                  {...(m.shown.key === KEPT ? { live, working: m.answering, onEdit: m.edit } : {})}
                  {...(m.status !== null && m.shown.key === KEPT ? { narrated: true } : {})}
                  {...(m.shown.key === KEPT ? doomed : {})}
                />
                {m.shown.key === KEPT ? asking : null}
              </Sheet>
            </View>
          </>
        ) : null}
      </ScrollView>

      {m.status !== null ? <LiveStatusBar status={m.status} {...(away ? { onJump: jump } : {})} /> : null}

      {m.waitingHere.length > 0 ? <Uncopied name="the messages waiting for the allowance" /> : null}

      <View flexShrink={0} backgroundColor={t.v("bg") as never}>
        {/* `.chat-foot::before`: the thread fading into the ground the box sits on (web; a phone draws no gradient ground). */}
        {isWeb ? <View position="absolute" left={0} right={0} top={-18} height={18} pointerEvents="none" {...({ backgroundImage: `linear-gradient(to bottom, transparent, ${String(t.v("bg"))})` } as object)} /> : null}
        {m.arming !== null ? (
          <View
            flexDirection="row"
            alignItems="center"
            gap={8}
            width="100%"
            maxWidth={900}
            alignSelf="center"
            marginTop={8}
            paddingVertical={5}
            paddingHorizontal={12}
            borderRadius={8}
            backgroundColor={t.mix(t.v(m.arming.kind === "rewind" ? "bad" : "accent"), 10, "transparent") as never}
          >
            <Txt spec={{ voice: "app", scale: 12 / 12.5, color: m.arming.kind === "rewind" ? "bad" : "dim" }} ellip flex={1} minWidth={0}>
              {armingText(m.arming)}
            </Txt>
            <Press onPress={m.disarm} paddingVertical={3} paddingHorizontal={10} borderRadius={7} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "text" }}>Cancel</Txt>
            </Press>
            {m.arming.kind === "rewind" ? (
              <Press onPress={m.confirmRewind} paddingVertical={3} paddingHorizontal={10} borderRadius={7} backgroundColor={t.v("bad") as never}>
                <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "panel" }}>Rewind</Txt>
              </Press>
            ) : null}
          </View>
        ) : null}
        {m.error !== null ? <ChatError text={m.error} /> : null}
        <Composer
          plan={m.plan ?? null}
          busy={m.sending > 0 || m.answering}
          joinable={m.thread !== null}
          overrides={m.overrides}
          onOverrides={m.setOverrides}
          value={m.draft}
          onValue={m.setDraft}
          onSend={m.send}
          onStop={m.stop}
          placeholder={replyPlaceholder(m.arming)}
          {...(m.plan === null && m.thread === null ? { disabled: "This conversation cannot be continued." } : {})}
          usage={{ context: m.lastContext, onCompact: m.onCompact, cost: m.thread?.costUsd }}
        />
      </View>
    </View>
  );
}

/** `.cx-error`: what went wrong, over the box. */
export function ChatError({ text }: { text: string }): JSX.Element {
  const t = useTokens();
  return (
    <View width="100%" maxWidth={900} alignSelf="center" marginBottom={6} paddingVertical={6} paddingHorizontal={12} borderRadius={8} backgroundColor={t.mix(t.v("bad"), 12, "transparent") as never}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "bad" }}>{text}</Txt>
    </View>
  );
}
