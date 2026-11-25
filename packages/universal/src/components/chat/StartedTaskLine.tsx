import { createContext, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { TaskStatus } from "@jaira/shared/browser";
import { askOfTask } from "@jaira/ui/approvalCall";
import { runningStepOf, stepsIn } from "@jaira/ui/childRunModel";
import { parkedGateOf } from "@jaira/ui/panelHost";
import { PLACES, taskPaneEntryOf, type Place } from "@jaira/ui/splitModel";
import { asksBelow, nestAfterAsks, SHUT, toggledDeep, toggledOne, type NestState } from "@jaira/ui/startedTaskModel";
import { useTaskRun } from "@jaira/ui/taskRun";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { useView } from "@jaira/ui/useView";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { useShell } from "../../app/shell";
import { placeTask, useEntryPlaces, usePlacesHere } from "../../app/places";
import { usePhone } from "../../app/phone";
import { Press, Txt, edge, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon, type IconName } from "../panel/Icon";
import { InNoteContext } from "../panel/noteContext";
import { RunTranscript, type TranscriptSource } from "../panel/RunTranscript";
import { useRunContext } from "../run/runContext";
import { Pulse } from "./Pulse";

/**
 * Inside a nest opened down to its question (a press on a wait, or a new question): every started task
 * drawn in it that has something asked under it opens down to it too, and the rest stay shut.
 */
export const RevealContext = createContext(false);

/** Where a started task stands while nothing under it asks and it does not work: said after its name. */
function standingOf(status: TaskStatus | undefined): { word: string; tone: "warn" | "bad" | "dim" } | undefined {
  switch (status) {
    case "interrupted":
      return { word: "interrupted", tone: "warn" };
    case "failed":
      return { word: "failed", tone: "bad" };
    case "canceled":
      return { word: "canceled", tone: "dim" };
    case "completed":
      return { word: "done", tone: "dim" };
    case "queued":
      return { word: "not started", tone: "dim" };
    default:
      return undefined;
  }
}

type SetNest = (next: NestState | ((was: NestState) => NestState)) => void;

/**
 * A nest's state, held where the line and the `start task` row above it can both press it: the row's
 * press is the line's own (`press`), which also takes the task back from where it is placed.
 */
export interface NestHandle {
  state: NestState;
  set: SetNest;
  press: { current: (() => void) | undefined };
}

export function useNestHandle(): NestHandle {
  const [state, set] = useState<NestState>(SHUT);
  const press = useRef<(() => void) | undefined>(undefined);
  return { state, set, press };
}

const PLACE_ICON: Record<Place, { icon: IconName; say: string }> = {
  main: { icon: "placeMain", say: "Open as the main view" },
  split: { icon: "placeSplit", say: "Open beside" },
  panel: { icon: "placePanel", say: "Open in the side panel" },
};

/**
 * The four places as one group (decision 0025's `PlaceButtons`, with "in place" first): in place, the
 * main view, beside, the side panel — the one the task is in lit.
 */
function PlaceGroup({ here, lit, offered, onHere, onPlace, deep }: { here: boolean; lit: readonly Place[]; offered: readonly Place[]; onHere: () => void; onPlace: (place: Place) => void; deep: boolean }): JSX.Element {
  const t = useTokens();
  const button = (key: string, icon: IconName, say: string, on: boolean, go: () => void): JSX.Element => (
    <Press
      key={key}
      onPress={go}
      label={say}
      title={say}
      {...({ "aria-pressed": on } as object)}
      width={26}
      height={24}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      box={({ hovered }) => (on ? { backgroundColor: t.mix(t.v("accent"), 14, t.v("panel")) } : hovered ? { backgroundColor: t.v("panel-2") } : {})}
    >
      {({ hovered }) => <Icon name={icon} size={15} color={String(on ? t.v("accent") : hovered ? t.v("text") : t.v("dim"))} />}
    </Press>
  );
  const what = deep ? " down to the question" : "";
  return (
    <View role="group" aria-label="Where to show it" flexDirection="row" gap={1} padding={1} flexShrink={0} borderRadius={7} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {button("here", here ? "fold" : "unfold", here ? "Fold it" : `Show it here${what}`, here, onHere)}
      {offered.map((place) => button(place, PLACE_ICON[place].icon, `${PLACE_ICON[place].say}${what}`, lit.includes(place), () => onPlace(place)))}
    </View>
  );
}

/**
 * A task a conversation STARTED of its own (decision 0029 §2), under the call that started it — the
 * mockups of 2026-11-24 (`docs/ui/assets/chat-view/child-asks-ways-in.html`). What you point at decides how
 * deep it opens, a click opens it here and a hover offers the four places:
 *
 *  - the arrow, its words (and the `start task` row above it, which shares {@link nest}): this task here,
 *    ONE level — its own run, the tasks it started shut;
 *  - its wait ("waiting for choose option in Lesson"): every task down to the one that asks, here;
 *  - hovering the wait: the group under the words — the four places, opened down to the question;
 *  - hovering the line: the group laid over its right end (never a second row) — one level.
 *
 * Each place is a window of its own (`placeTask`): opening it beside, in the panel or in this frame
 * leaves the nest here as it is, and the buttons light where it is shown. A new question opens it down
 * to the question by itself while it is shown nowhere else, and a nest a question opened shuts once it is
 * answered. Its own run is read by its id only while the nest is open (decision
 * 0003: "expanding subscribes to the child's turns as a watched conversation does"). A phone has no
 * hover: a long press on the line or the wait brings its group up.
 *
 *   the line        row, centred, gap 8, padding 4, app 11.5/12.5 --dim; hovered: --panel-2 70%, radius 7
 *   the arrow       18 square, radius 5, the chevron 13 turned −90° while shut; hovered --panel-2
 *   the name        600 --text
 *   the wait        --warn, the step data 600; hovered --warn 12% ground, underlined; its group under it,
 *                   "show the question" before it, on --panel, 1px --line, radius 9, a shadow
 *   the tail        pushed right: data 10.5/12 --dim, tabular; hidden under the line's group while hovered
 *   the nest        the line's width, margin 4 0 8 18, padding-left 8, 2px --accent 45% into --line
 */
export function StartedTaskLine({ taskId, project, nest }: { taskId: string; project?: string | undefined; nest?: NestHandle | undefined }): JSX.Element {
  const t = useTokens();
  const { state } = useShell();
  const reveal = useContext(RevealContext);
  const own = useNestHandle();
  const { state: nestState, set: setNest } = nest ?? own;
  const detail = useView("task:detail", { taskId }).value ?? null;
  const root = detail?.instances[0];
  const working = detail?.status === "running";
  const now = useNow(working);
  const asks = useMemo(() => asksBelow(taskId, state.allTasks, state), [taskId, state.allTasks, state.pending, state.questions, state.approvals]);
  const entry = useMemo(() => taskPaneEntryOf(taskId, project), [taskId, project]);
  const lit = useEntryPlaces(entry.key);
  const phone = usePhone();
  const placesHere = usePlacesHere(phone);
  const offered = PLACES.filter((place) => place === "main" || placesHere[place] || lit.includes(place));
  const elsewhere = lit.length > 0;

  // Opened from above down to a question: open down to it too, while something under this one asks.
  useEffect(() => {
    if (reveal && asks.length > 0 && !elsewhere) setNest((was) => (was.mode === "shut" ? { mode: "deep", by: "ask" } : was));
    // Only as it is first drawn: a reveal opens what is under it once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A new question opens it; the last one answered shuts what a question opened.
  const asked = useRef(asks.length);
  useEffect(() => {
    const before = asked.current;
    asked.current = asks.length;
    if (before !== asks.length) setNest((was) => nestAfterAsks(was, before, asks.length, elsewhere));
  }, [asks.length, elsewhere, setNest]);

  // Each place is a window of its own (`placeTask`): the nest here is opened and shut by itself.
  const here = nestState.mode !== "shut";
  const placeAt = (place: Place, deep: boolean): void => placeTask(place, deep && entry.kind === "task" ? { ...entry, reveal: true } : entry, phone);
  const toggleOne = (): void => setNest(toggledOne);
  const toggleDeep = (): void => setNest(toggledDeep);
  (nest ?? own).press.current = toggleOne;

  const [lineHovered, lineHover] = useHover();
  const [waitHovered, waitHover] = useHover();
  const [pressedLong, setPressedLong] = useState<"line" | "wait" | null>(null);
  const showLineGroup = (lineHovered && !waitHovered) || pressedLong === "line";
  const showWaitGroup = waitHovered || pressedLong === "wait";
  const longPress = (which: "line" | "wait") => (): void => setPressedLong((was) => (was === which ? null : which));

  const step = asks.length === 0 && working && root !== undefined ? runningStepOf(root) : undefined;
  const ended = working ? undefined : root?.endedAt;
  const took = root?.startedAt === undefined ? "" : `${secondsOf(Math.max(0, (ended ?? now) - root.startedAt))}${working ? " so far" : ""}`;
  const name = detail?.title ?? taskId;
  const standing = asks.length === 0 && step === undefined ? standingOf(detail?.status) : undefined;
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const first = asks[0];
  const waitWords = first === undefined ? "" : asks.length === 1 ? first.step : `${asks.length} things`;
  const whereWords = first === undefined || asks.length > 1 || first.path.length === 0 ? "" : `in ${first.path.join(" › ")}`;
  const steps = root !== undefined ? stepsIn(root) : 0;

  return (
    <View
      role="note"
      flexDirection="row"
      flexWrap="wrap"
      alignItems="center"
      gap={8}
      padding={4}
      minWidth={0}
      position="relative"
      borderRadius={7}
      {...lineHover}
      backgroundColor={showLineGroup ? (t.mix(t.v("panel-2"), 70, "transparent") as never) : ("transparent" as never)}
    >
      <Press
        onPress={toggleOne}
        onLongPress={longPress("line")}
        label={here ? `fold ${name}` : `show ${name} here`}
        {...({ "aria-expanded": here } as object)}
        width={18}
        height={18}
        alignItems="center"
        justifyContent="center"
        borderRadius={5}
        flexShrink={0}
        box={({ hovered }) => (hovered ? { backgroundColor: t.v("panel-2") } : {})}
      >
        <View transform={here ? [] : [{ rotate: "-90deg" }]}>
          <Icon name="chevron" size={13} color={String(t.v("dim"))} />
        </View>
      </Press>
      <Press onPress={toggleOne} onLongPress={longPress("line")} flexDirection="row" alignItems="baseline" gap={8} minWidth={0} flexShrink={1} title={`${name} — ${here ? "fold it" : "show it here"}`}>
        <Txt spec={words} flexShrink={0}>
          started
        </Txt>
        <Txt spec={{ ...words, weight: 600, color: "text" }} ellip flexShrink={1} minWidth={0}>
          {name}
        </Txt>
      </Press>
      {first !== undefined ? (
        <>
          <Txt spec={{ ...words, color: "faint" }}>·</Txt>
          <View position="relative" flexShrink={1} minWidth={0} {...waitHover}>
            <Press
              onPress={toggleDeep}
              onLongPress={longPress("wait")}
              title="show the question here"
              flexDirection="row"
              alignItems="center"
              gap={5}
              paddingHorizontal={3}
              marginHorizontal={-3}
              borderRadius={5}
              minWidth={0}
              box={() => (showWaitGroup ? { backgroundColor: t.mix(t.v("warn"), 12, t.v("panel")) } : {})}
            >
              <Icon name="pause" size={12} color={String(t.v("warn"))} />
              <Txt spec={{ ...words, color: "warn" }} flexShrink={0} textDecorationLine={showWaitGroup ? "underline" : "none"}>
                waiting for
              </Txt>
              <Txt spec={{ ...words, voice: "data", weight: 600, color: "warn" }} fontSize={t.scaled("size-app", 11.5 / 12.5)} flexShrink={0} textDecorationLine={showWaitGroup ? "underline" : "none"}>
                {waitWords}
              </Txt>
            </Press>
            {showWaitGroup ? (
              // Under the words, over what follows: the four places, opened down to the question.
              <View position="absolute" top="100%" left={0} zIndex={5} paddingTop={6}>
                <View flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingRight={4} paddingLeft={9} borderRadius={9} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} {...({ boxShadow: "0px 6px 18px rgba(15, 20, 30, 0.16)" } as object)}>
                  <Txt spec={{ ...words, scale: 11 / 12.5 }} numberOfLines={1}>
                    show the question
                  </Txt>
                  <PlaceGroup here={here && nestState.mode === "deep"} lit={lit} offered={offered} onHere={toggleDeep} onPlace={(place) => placeAt(place, true)} deep />
                </View>
              </View>
            ) : null}
          </View>
          {whereWords !== "" ? (
            <Txt spec={words} ellip flexShrink={1} minWidth={0}>
              {whereWords}
            </Txt>
          ) : null}
        </>
      ) : step !== undefined ? (
        <>
          <Txt spec={{ ...words, color: "faint" }}>·</Txt>
          <View alignSelf="center">
            <Pulse />
          </View>
          <Txt spec={words} flexShrink={0}>
            running
          </Txt>
          <Txt spec={{ ...words, voice: "data", weight: 600, color: "text" }} fontSize={t.scaled("size-app", 11.5 / 12.5)} flexShrink={0}>
            {step.step}
          </Txt>
        </>
      ) : standing !== undefined ? (
        <>
          <Txt spec={{ ...words, color: "faint" }}>·</Txt>
          <Txt spec={{ ...words, color: standing.tone }} flexShrink={0}>
            {standing.word}
          </Txt>
        </>
      ) : null}
      {/* The steps and time, pushed right — hidden, not moved, under the line's group while it is hovered. */}
      <View flexShrink={0} marginLeft="auto" paddingLeft={8} opacity={showLineGroup ? 0 : 1}>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} paddingHorizontal={3}>
          {root !== undefined ? `${steps} ${steps === 1 ? "step" : "steps"} · ${took}` : ""}
        </Txt>
      </View>
      {showLineGroup ? (
        // Laid over the line's right end, never a second row: this task, one level.
        <View position="absolute" right={4} top={0} height={32} justifyContent="center" paddingLeft={24} zIndex={4} {...({ backgroundImage: `linear-gradient(to right, transparent, ${String(t.mix(t.v("panel-2"), 70, t.v("panel")))} 22px)` } as object)}>
          <PlaceGroup here={here} lit={lit} offered={offered} onHere={toggleOne} onPlace={(place) => placeAt(place, false)} deep={false} />
        </View>
      ) : null}
      {here ? (
        <View flexBasis="100%" flexShrink={1} minWidth={0} marginTop={4} marginBottom={8} marginLeft={18} paddingLeft={8} {...(edge(t, { left: 2 }, t.mix(t.v("accent"), 45, t.v("line"))) as object)}>
          <InNoteContext.Provider value={true}>
            <RevealContext.Provider value={nestState.mode === "deep"}>
              <NestedTask taskId={taskId} project={project} />
            </RevealContext.Provider>
          </InNoteContext.Provider>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A started task's own run, nested: read by its id while it is drawn (`taskRun.ts`), drawn by the same
 * conversation with no scroller, and — unlike an adoption's history — with what it asks the person: its
 * gate, its agent's question and approval, answered here.
 */
function NestedTask({ taskId, project }: { taskId: string; project: string | undefined }): JSX.Element {
  const host = useRunContext();
  const { state, actions } = useShell();
  const { detail, failed, context } = useTaskRun(taskId, project, host as unknown as FileSurfaceContext);
  if (failed !== null) return <Quiet>{`Could not read this task: ${failed}`}</Quiet>;
  if (detail === null) return <Quiet>Loading…</Quiet>;
  const gate = parkedGateOf(state.pending, taskId);
  const approval = askOfTask(state.approvals, taskId);
  const question = state.questions.find((q) => q.taskId === taskId);
  const source: TranscriptSource = {
    ...(host as unknown as TranscriptSource),
    conversation: context.conversation,
    sessions: context.sessions,
    sessionHistory: context.sessionHistory,
    records: context.records,
    liveTurn: context.liveTurn,
    onLoadSessions: context.onLoadSessions,
    project: context.project ?? project,
    userEvents: [],
    approval,
    onApproval: approval !== undefined ? (decision, scope, extras) => void actions.decideApproval(approval.requestId, decision, scope, extras) : undefined,
    question,
    onQuestion: question !== undefined ? (answers) => void actions.answerQuestion(question.requestId, answers) : undefined,
  };
  return (
    <RunTranscript
      nested
      detail={detail}
      parent={detail.instances[0]}
      source={source}
      {...(gate !== undefined ? { gate, onGate: (value: unknown) => void actions.answer(gate.requestId, value) } : {})}
      onArm={() => undefined}
    />
  );
}

function Quiet({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} paddingVertical={8}>
      {children}
    </Txt>
  );
}
