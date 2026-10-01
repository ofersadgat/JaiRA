import { useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { BoardCard } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { BADGE } from "@jaira/ui/panelFaceModel";
import { taskNameNote, taskNameOf, taskNamePending } from "@jaira/ui/taskName";
import { nodeAt } from "@jaira/ui/trail";
import { entriesOf, journalFor, markAnsweredQuestions } from "@jaira/ui/transcript";
import { PLAIN_SCROLLER, Press, Txt, edge, scrollbarProps, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Paper } from "../chat/Paper";
import { Transcript } from "../panel/SessionTranscript";
import { SidechainConversation } from "../run/SidechainConversation";
import { Button } from "../settings/Button";

/**
 * `fileSurfaces.tsx`'s `LeafPanel`, universal (decision 0015): a leaf state opened in the Files room —
 * the tasks in it down the side, and what the selected one said beside them, the one stream of the
 * state's words (`entriesOf` over its journal, `transcript.ts`) printed on its sheet. Standing on a
 * sidechain step, the panel is that subagent's conversation (`SidechainConversation`), as a composite's
 * is. The rules, from `styles.css` (`cascade.mts '.leaf' --scene files-state`):
 *
 *   .leaf              flex 1; grid 190 | minmax(0, 1fr)
 *   .leaf-list         --panel, 1px --line on its right, padding 11, column, gap 3, scrolls down
 *   .leaf-list h3      margin 6 0 4 (kept: a flex column); `h3`'s app 700 at 11/12.5, 0.09em, uppercase,
 *                      --dim, a row spaced between, centred, gap 8; its `.count` 400
 *   .leaf-row          row, centred, gap 6, padding 5 7, radius 6, app 12.5/12.5; hovered
 *                      --fill-ghost-hover; `.sel` --fill-ghost-selected at 600
 *   .badge             16 wide, centred, the row's font; its status's colour (`.badge-<status>`; none
 *                      for a status without a rule, which keeps the row's)
 *   .task-name         grows, one line, …; `-pending` italic --dim; `-fallback` underlined dotted --dim
 *   .leaf-convo        column, CLIPPED (its `overflow: hidden` wins over `.scroll`'s): the sheet does not scroll
 *   .ts-page           at least the column's height (`Paper`)
 *   .waiting-on        row, centred, gap 9, padding 9 11, 1px --warn, radius 8, --bg, --warn; not in the flow
 *   p.empty            --dim, 8 above and below, a paragraph's margins (1em of the body's 13)
 */
export function LeafPanel({ context }: { context: FileSurfaceContext }): JSX.Element {
  const t = useTokens();
  const { state, selected, conversation, waiting, onSelectTask, onAnswer, session, liveTurn } = context;
  // The host of any doorway in THIS transcript is the instance whose session is on screen.
  const host = context.sessionInstance !== null && context.sessionInstance !== undefined ? nodeAt(context.detail?.instances ?? [], context.sessionInstance) : undefined;
  // An agent question the control conversation answered says so here too (`markAnsweredQuestions`).
  const marks = host?.answeredQuestions;
  const entries = useMemo(
    () => markAnsweredQuestions(entriesOf(session, journalFor(conversation?.turns ?? [], state?.stateId), liveTurn), marks),
    [session, conversation, state?.stateId, liveTurn, marks],
  );
  // `.ts-page`'s `min-height: 100%`: the column's own height.
  const [height, setHeight] = useState<number | undefined>(undefined);
  const onWalkIntoSidechain = context.onWalkIntoSidechain;
  const tail = context.trail?.at(-1);
  if (tail?.sidechain !== undefined) {
    return (
      <View flex={1} minHeight={0} flexDirection="column">
        <SidechainConversation
          step={tail}
          detail={context.detail}
          source={{ sessions: context.sessions ?? {}, onLoadSessions: context.onLoadSessions ?? (() => undefined), liveTurn: context.liveTurn, ...(onWalkIntoSidechain !== undefined ? { onWalkIntoSidechain } : {}) }}
        />
      </View>
    );
  }
  if (state === null) return <Empty t={t}>No state loaded.</Empty>;
  const h3: FontSpec = { voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.09, upper: true, color: "dim" };
  return (
    <View flex={1} minHeight={0} flexDirection="row">
      <View width={190} flexShrink={0} minHeight={0} backgroundColor={t.v("panel") as never} {...(edge(t, { right: 1 }) as object)}>
        <ScrollView style={PLAIN_SCROLLER} contentContainerStyle={{ ...PLAIN_SCROLLER, padding: 11, gap: 3 }} {...scrollbarProps(t)}>
          <Head>
            <Txt spec={h3}>Tasks here</Txt>
            <Txt spec={{ ...h3, weight: 400 }}>{String(state.tasksHere.length)}</Txt>
          </Head>
          {state.tasksHere.map((card) => (
            <LeafRow key={card.taskId} card={card} status={card.activeStatus ?? card.status} sel={card.taskId === selected} onPress={() => onSelectTask(card.taskId)} t={t} />
          ))}
          {state.tasksHere.length === 0 ? <Empty t={t}>Nothing here right now.</Empty> : null}
          {state.tasksRecent.length > 0 ? (
            <>
              <Head>
                <Txt spec={h3}>Recently</Txt>
              </Head>
              {state.tasksRecent.map((card) => (
                <LeafRow key={card.taskId} card={card} status={card.status} sel={card.taskId === selected} onPress={() => onSelectTask(card.taskId)} t={t} />
              ))}
            </>
          ) : null}
        </ScrollView>
      </View>
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column" overflow="hidden" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
        <Paper minHeight={height}>
          <Transcript
            session={session}
            entries={entries}
            live={liveTurn}
            empty={selected === null ? "Select a run to see what it said." : undefined}
            {...(onWalkIntoSidechain !== undefined && host !== undefined ? { onOpenSidechain: (call: string, name: string) => onWalkIntoSidechain(host, call, name) } : {})}
          />
        </Paper>
        {waiting ? (
          // Pinned rather than in the flow: it is the one turn that is not history.
          <View
            flexDirection="row"
            alignItems="center"
            gap={9}
            paddingVertical={9}
            paddingHorizontal={11}
            borderRadius={8}
            backgroundColor={t.v("bg") as never}
            flexShrink={0}
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "warn") as object)}
          >
            <Badge status="waiting_for_user" spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }} />
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }} flex={1} minWidth={0}>
              {"Waiting on you — "}
              {waiting.component}
            </Txt>
            {onAnswer ? (
              <Button kind="primary" onPress={onAnswer}>
                Answer
              </Button>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** `.leaf-list h3`: 6 above and 4 below (a flex column keeps them), spaced between. */
function Head({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={8} marginTop={6} marginBottom={4}>
      {children}
    </View>
  );
}

/** `.leaf-row`: the task's badge and its name, pressed to show what it said. */
function LeafRow({ card, status, sel, onPress, t }: { card: BoardCard; status: string; sel: boolean; onPress: () => void; t: Tokens }): JSX.Element {
  const spec: FontSpec = { voice: "app", scale: 1, weight: sel ? 600 : 400 };
  const pending = taskNamePending(card);
  const fallback = card.heading?.error !== undefined;
  const note = taskNameNote(card);
  return (
    <Press
      onPress={onPress}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingVertical={5}
      paddingHorizontal={7}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: sel ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Badge status={status} spec={spec} />
      <Txt
        spec={{ ...spec, ...(pending ? { italic: true, color: "dim" } : {}) }}
        flex={1}
        minWidth={0}
        ellip
        {...(isWeb && note !== undefined ? { title: note } : {})}
        {...(fallback ? { style: { textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: t.v("dim"), textUnderlineOffset: 3 } } : {})}
      >
        {taskNameOf(card)}
      </Txt>
    </Press>
  );
}

/** The statuses `styles.css` colours a `.badge` for; any other keeps the colour it stands in. */
const BADGE_INK: Record<string, string> = {
  running: "accent",
  interrupted: "accent",
  waiting_for_user: "warn",
  completed: "ok",
  failed: "bad",
  blocked: "bad",
  timeout: "bad",
  canceled: "dim",
  queued: "dim",
};

/** `board.tsx`'s `Badge`: a task's status glyph, 16 wide, in the font it stands in and its status's colour. */
function Badge({ status, spec }: { status: string; spec: FontSpec }): JSX.Element {
  const ink = BADGE_INK[status];
  return (
    <Txt spec={{ ...spec, ...(ink !== undefined ? { color: ink } : {}) }} width={16} textAlign="center" flexShrink={0} {...(isWeb ? { title: status } : {})}>
      {BADGE[status] ?? "·"}
    </Txt>
  );
}

/** `p.empty`: --dim, 8 above and below, and the paragraph's margins (1em of the body's 13). */
function Empty({ children, t }: { children: ReactNode; t: Tokens }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}
