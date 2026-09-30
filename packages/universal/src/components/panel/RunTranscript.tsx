import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { Platform, ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View } from "@tamagui/core";
import { type InstanceNode, type OperationRecordView, type PendingInteraction, type ReadCall, type TaskDetail } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { armedRewindOf, callsOf, lastContextOf, settledGateCallOf, settledGateOf, toldOf, type ArmedRewind } from "@jaira/ui/runConversationModel";
import type { ComponentServices } from "@jaira/ui/changesetReviewModel";
import type { EditMessage } from "@jaira/ui/transcriptView";
import { invoke } from "@jaira/ui/store";
import { AnsweredForYou } from "./WorkRows";
import { PendingSend } from "./PendingSend";
import { paletteOfRun } from "@jaira/ui/rail";
import { bandsOf, instancesOf, mountPathOf, notesOf, piecesOf, recordAt, type SessionPiece } from "@jaira/ui/sessionBands";
import { sessionKey } from "@jaira/ui/sessionCache";
import { askingInstanceOf, isAsking, runningLeafOf, surfaceKindOf } from "@jaira/ui/stateSurface";
import { approvalCallIndex } from "@jaira/ui/approvalCall";
import type { ApprovalSurfaceProps } from "@jaira/ui/approvalSurface";
import type { CallSurface } from "@jaira/ui/transcriptRows";
import { ApprovalAskContext } from "@jaira/ui/workSummaryContext";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { QuestionSurface } from "../floats/QuestionSurface";
import { entriesOf, entriesOfPart, journalFor, markAnsweredQuestions, previewOf } from "@jaira/ui/transcript";
import { Txt, edge, scrollbarProps } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { GateSurface } from "./Gate";
import { Icon } from "./Icon";
import { SessionBands, baselineOf, collapsed, sheetLookOf, type CutOffer } from "./SessionBands";
import { Transcript } from "./SessionTranscript";
import { ValueView } from "./ValueView";
import { Button } from "../settings/Button";
import { advanceTargetOf } from "@jaira/ui/stateSurface";
import { durationOf, useElapsed } from "@jaira/ui/runActivityModel";
import { moveQuestionConfig, parseComponentConfig, type MoveQuestionView, type PendingApproval, type PendingQuestion, type PendingUserEvent, type SettledByView } from "@jaira/shared/browser";

/** What a run's conversation is read from — the store's fields `App.tsx` hands `FileSurfaceContext`. */
export type TranscriptSource = Pick<FileSurfaceContext, "conversation" | "sessions" | "sessionHistory" | "records" | "liveTurn" | "onLoadSessions" | "shutStates" | "onToggleShutState" | "onSetShutStates" | "batches" | "userEvents"> &
  Partial<Pick<FileSurfaceContext, "moveQuestions" | "onMoveQuestion" | "onSelectTask" | "onRewind" | "onFork" | "onWalkIntoSidechain" | "onOpenWorkflow">> & {
  /** What the shell lends a gate that mounts the changeset reviewer (`App.tsx`'s `reviewerServices`). */
  gateServices?: Partial<ComponentServices> | undefined;
  /** Answer a parked transition (`WaitingOn`'s button). */
  onDeliverUserEvent?: ((requestId: string) => void) | undefined;
  /** The project the task stands in — what "Answer it yourself" is asked in. */
  project?: string | undefined;
  /** A command the running agent waits to have approved, and how to answer it. */
  approval?: PendingApproval | undefined;
  onApproval?: ApprovalSurfaceProps["onDecide"] | undefined;
  /** A question the running agent put to the person, and how to answer it. */
  question?: PendingQuestion | undefined;
  onQuestion?: ((answers: Record<string, string | string[]> | undefined) => void) | undefined;
};

/**
 * `runViews.tsx`'s `RunConversation`, its scroller and what is in it, universal (decision 0015): the
 * run's sessions as panels down the page (`sessionPanels.tsx`'s `SessionBandsView`), the notes between
 * them, and the rail beside it all. The page's rows are `pageRowsOf` (`sessionRows.ts`), the same as the
 * DOM's; the pieces, notes and palette are `sessionBands.ts`' and `rail.ts`'s.
 *
 * The page is `SessionBands.tsx` (bands of one session or several, torn edges, fork marks, the notes —
 * entered, blocked, made, asked, moved — the origin seam and an armed cut); what a piece says is here:
 * the transcript (`SessionTranscript.tsx`), a state that called a function (`SilentState`), a gate asked
 * or settled (and one answered offline), the running agent's approval or question, and a parked
 * transition (`WaitingOn`). An entered row's rewind is ARMED here and asked about under the scroller
 * (`armed`, `onArm` — the host holds it, as the strip is its); its fork, and the same two verbs on the
 * message that opened each state's conversation, go straight to the host. A subagent's doorway walks
 * into its conversation (`onOpenSidechain`, else the trail's `onWalkIntoSidechain`).
 *
 *   .run-convo      flex 1, scrolls, follows the live edge
 *   .sb             column, at least the scroller's height, --bg, padding 14 16 22
 */
export function RunTranscript({
  detail,
  parent = detail.instances[0],
  source,
  gate,
  onGate,
  armed,
  onArm,
  onOpenSidechain,
}: {
  detail: TaskDetail;
  /** The run being READ — the trail's tail in the middle column, the task's root in the panel. */
  parent?: InstanceNode | undefined;
  source: TranscriptSource;
  gate?: PendingInteraction;
  onGate?: (value: unknown) => void;
  /** A rewind armed from an entered row, not yet confirmed: the page fades from it. */
  armed?: ArmedRewind | null | undefined;
  /** Arm a rewind — the host's strip asks about it. Absent ⇒ no cut is offered. */
  onArm?: ((armed: ArmedRewind) => void) | undefined;
  /** Where "walk in →" on a subagent's doorway goes, for this host. The node is the piece it was in. */
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const { conversation, sessions, sessionHistory, records, liveTurn, onLoadSessions, shutStates, onToggleShutState, onSetShutStates } = source;
  const bands = useMemo(() => bandsOf(piecesOf(parent, sessionHistory), { batches: source.batches }), [parent, sessionHistory, source.batches]);
  const needed = useMemo(() => instancesOf(bands), [bands]);
  const palette = useMemo(() => paletteOfRun(detail.instances), [detail.instances]);
  const notes = useMemo(() => notesOf(conversation?.turns ?? [], parent), [conversation, parent]);
  const rootPath = useMemo(() => (parent === undefined ? "" : mountPathOf(detail.instances, parent.instanceId)), [detail, parent]);
  const askingHere = useMemo(() => (gate === undefined || onGate === undefined ? undefined : askingInstanceOf(detail.instances)), [gate, onGate, detail.instances]);
  const waits = useMemo(() => [...source.userEvents].filter((one) => one.taskId === detail.taskId).sort((a, b) => a.at - b.at), [source.userEvents, detail.taskId]);
  // Where a running agent's question or approval is drawn: under the leaf whose call is running.
  const agentHere = useMemo(
    () => ((source.question !== undefined && source.onQuestion !== undefined) || (source.approval !== undefined && source.onApproval !== undefined) ? runningLeafOf(detail.instances) : undefined),
    [source.question, source.onQuestion, source.approval, source.onApproval, detail.instances],
  );
  // The workflow tools' notes are drawn on the RAIL (`jaira.moved`), and "Answer it yourself" under an
  // agent's question is the gate's own rewind.
  const calls = useMemo<CallSurface>(
    () => ({
      outcomes: "rail",
      onAnswerYourself: (by: SettledByView) => void invoke("task:answerYourself", { taskId: detail.taskId, at: by.at, ...(source.project !== undefined && source.project !== "" ? { project: source.project } : {}) }).catch(() => undefined),
    }),
    [detail.taskId, source.project],
  );
  const openSidechain = onOpenSidechain ?? source.onWalkIntoSidechain;
  /** How full each state's conversation was after its last turn — what its letterhead's `+30k` is worked out from. */
  const readingOf = (piece: SessionPiece) => lastContextOf(sessions[sessionKey(recordAt(piece))]);
  // The two verbs of a cut on every entered row: a rewind is armed (the host asks in its strip), a fork
  // starts at once.
  const { onRewind, onFork } = source;
  const onCut = useMemo<CutOffer | undefined>(() => {
    if (onRewind === undefined || onFork === undefined || onArm === undefined) return undefined;
    const taskId = detail.taskId;
    return {
      rewind: (note) => onArm(armedRewindOf(note, notes, rootPath)),
      fork: (note) => onFork(taskId, note.seq),
    };
  }, [detail.taskId, onRewind, onFork, onArm, notes, rootPath]);

  // Every panel is open, so every transcript in them is needed — fetched in one round.
  useEffect(() => {
    const missing = needed.filter((one) => sessions[sessionKey(one)] === undefined);
    if (missing.length > 0) onLoadSessions(missing);
  }, [needed, sessions, onLoadSessions]);

  const follow = useLiveEdge(detail.taskId);

  const render = (piece: SessionPiece): ReactNode => {
    if (gate !== undefined && onGate !== undefined && isAsking(piece.node)) {
      // Answered here for a machine that is offline: drawn as answered, with the answer waiting.
      if (gate.queued !== undefined && gate.offline !== undefined) {
        const outboxId = gate.queued.outboxId;
        return (
          <>
            <GateSurface pending={gate} onSubmit={() => undefined} settled={{ value: gate.queued.value }} plain services={source.gateServices} />
            <PendingSend machine={gate.offline.machine} onTakeBack={() => void invoke("machines:withdraw", { id: outboxId }).catch(() => undefined)} />
          </>
        );
      }
      return <GateSurface pending={gate} onSubmit={onGate} plain services={source.gateServices} />;
    }
    // The question once it is no longer being asked: the same control, as it was answered.
    const settledCall = settledGateCallOf(piece.node, records, gate !== undefined && isAsking(piece.node));
    if (settledCall !== undefined) return <SettledGate call={settledCall} node={piece.node} taskId={detail.taskId} project={source.project} services={source.gateServices} />;
    const silent = piece.sessionId === undefined && surfaceKindOf(piece.node) !== "conversation";
    if (silent || piece.node.operation?.status === "failed") return <SilentState node={piece.node} records={records} />;
    const view = sessions[sessionKey(recordAt(piece))];
    if (view === undefined) return <Empty>Loading…</Empty>;
    const matches =
      liveTurn !== null &&
      (piece.sessionId !== undefined ? liveTurn.sessionId === piece.sessionId && liveTurn.seq === piece.seq : liveTurn.stateId === piece.node.stateId && piece.node.status === "running");
    const live = matches ? liveTurn : null;
    const entries = entriesOfPart(markAnsweredQuestions(entriesOf(view, journalFor(conversation?.turns ?? [], piece.node.stateId), live), piece.node.answeredQuestions), piece.part);
    // The message that opened this state's conversation is where its entry into the run is: a rewind or
    // a fork from it cuts at the same journal point as the rail's entered row — for a message typed into
    // the run, before that message.
    const entered = onCut !== undefined ? notes.find((note) => note.kind === "entered" && note.instanceId === piece.node.instanceId) : undefined;
    const opening = entries.find((entry): entry is Extract<typeof entry, { kind: "message" }> => entry.kind === "message" && entry.role === "user")?.turn;
    const onEdit: EditMessage | undefined =
      entered !== undefined && onCut !== undefined && opening !== undefined
        ? { can: () => false, edit: () => undefined, cut: (turn) => (turn === opening ? "before" : undefined), rewind: () => onCut.rewind(entered), fork: () => onCut.fork(entered) }
        : undefined;
    const transcript = (
      <Transcript
        session={view}
        entries={entries}
        live={live}
        calls={calls}
        rails
        onEdit={onEdit}
        {...(piece.sessionId !== undefined ? { scope: piece.sessionId } : {})}
        {...(openSidechain !== undefined ? { onOpenSidechain: (call: string, name: string) => openSidechain(piece.node, call, name) } : {})}
      />
    );
    // The agent's question or the command it is waiting to run, under what it said before asking.
    if (piece.node.instanceId !== agentHere) return transcript;
    const { approval, onApproval, question, onQuestion } = source;
    // The approval as the step it is: when this piece's conversation holds its call, the work summary
    // draws the prompt in that step's row (`ApprovalAskContext`) and it is not drawn again here.
    const inTranscript = approval !== undefined && approvalCallIndex(entries as never, approval.requestId) >= 0;
    return (
      <>
        {approval !== undefined && onApproval !== undefined && inTranscript ? <ApprovalAskContext.Provider value={{ pending: approval, onDecide: onApproval }}>{transcript}</ApprovalAskContext.Provider> : transcript}
        {approval !== undefined && onApproval !== undefined && !inTranscript ? (
          <InlineHost>
            <ApprovalSurface key={approval.requestId} pending={approval} onDecide={onApproval} />
          </InlineHost>
        ) : null}
        {question !== undefined && onQuestion !== undefined ? (
          <InlineHost>
            <QuestionSurface key={question.requestId} pending={question} onSubmit={onQuestion} />
          </InlineHost>
        ) : null}
      </>
    );
  };

  /**
   * A move's INPUT QUESTION, where the move asked it: the question itself while it is open — answering
   * it takes the move — and, once it is not, the same question as it was answered.
   */
  const moveQuestion = (asked: MoveQuestionView): ReactNode => {
    const live = source.moveQuestions?.find((pending) => pending.requestId === asked.requestId);
    if (live !== undefined && source.onMoveQuestion !== undefined) {
      return (
        <InlineHost>
          <GateSurface key={live.requestId} pending={live} onSubmit={(value) => source.onMoveQuestion!(live.requestId, value)} />
        </InlineHost>
      );
    }
    const inputs = moveQuestionConfig(detail.title ?? "this task", asked.targetLabel ?? asked.target, asked.missing, asked.optional ?? []);
    const settled: PendingInteraction = { requestId: asked.requestId, taskId: detail.taskId, project: "", component: "choose_option", inputs, config: parseComponentConfig("choose_option", inputs) };
    return (
      <InlineHost>
        <GateSurface
          pending={settled}
          onSubmit={() => undefined}
          settled={{ value: asked.answered !== undefined ? { answers: asked.answered } : undefined }}
          {...(asked.outcome === "refused" ? { error: `The move could not be taken: ${asked.message ?? "refused"}` } : {})}
        />
      </InlineHost>
    );
  };
  const empty = bands.length === 0 && notes.length === 0;
  return (
    <ScrollView {...(scrollbarProps(t) as object)} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ flexGrow: 1 }} {...follow}>
      <View flexGrow={1} flexDirection="column" backgroundColor={t.v("bg") as never} paddingTop={14} paddingHorizontal={16} paddingBottom={22}>
        {empty ? (
          <Empty>This run has not entered a child yet.</Empty>
        ) : (
          <SessionBands
            bands={bands}
            notes={notes}
            root={rootPath}
            render={render}
            palette={palette}
            asking={askingHere}
            shut={shutStates}
            onToggle={onToggleShutState}
            onSetShut={onSetShutStates}
            scope={detail.taskId}
            cuts={onCut}
            {...(armed !== undefined && armed !== null ? { armed: { seq: armed.seq, at: armed.at } } : {})}
            moveQuestion={moveQuestion}
            {...(source.onSelectTask !== undefined ? { onSelectTask: source.onSelectTask } : {})}
            {...(source.onOpenWorkflow !== undefined ? { onOpenWorkflow: (piece: SessionPiece) => source.onOpenWorkflow!(piece.node.stateId, piece.node.instanceId) } : {})}
            readingOf={readingOf}
            {...(detail.origin !== undefined ? { origin: { ...detail.origin, ...(source.onSelectTask !== undefined ? { onGo: () => source.onSelectTask!(detail.origin!.taskId) } : {}) } } : {})}
          />
        )}
        {waits.map((request) => (
          <WaitingOn key={request.requestId} request={request} onDeliver={() => source.onDeliverUserEvent?.(request.requestId)} />
        ))}
      </View>
    </ScrollView>
  );
}

/**
 * Follow the live edge (`useStickToBottom`): pinned to the end until the reader scrolls away from it,
 * and pinned again when `reset` changes (a different run is a different conversation). Spread on the
 * `ScrollView`.
 */
export function useLiveEdge(reset: unknown): {
  ref: RefObject<ScrollView | null>;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
  onContentSizeChange: () => void;
  onLayout: () => void;
} {
  const ref = useRef<ScrollView | null>(null);
  const following = useRef(true);
  const lastY = useRef(0);
  useEffect(() => {
    following.current = true;
  }, [reset]);
  return {
    ref,
    // Only a move UP lets go of the edge: content arriving does not move the offset, and the pin's own
    // scroll goes down — so neither can be mistaken for the reader leaving.
    onScroll: (e) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      if (y + layoutMeasurement.height >= contentSize.height - 4) following.current = true;
      else if (y < lastY.current - 1) following.current = false;
      lastY.current = y;
    },
    scrollEventThrottle: 32,
    onContentSizeChange: () => {
      if (following.current) toEnd(ref.current);
    },
    onLayout: () => {
      if (following.current) toEnd(ref.current);
    },
  };
}

/**
 * To the live edge. On web past it, as the DOM's `scrollTop = scrollHeight` does: the browser clamps to
 * the true (fractional) end, where `scrollToEnd` works it out from whole-pixel heights and stops a
 * fraction short.
 */
function toEnd(view: ScrollView | null): void {
  if (view === null) return;
  if (Platform.OS === "web") view.scrollTo({ y: 1e9, animated: false });
  else view.scrollToEnd({ animated: false });
}

/**
 * `WaitingOn`: a transition parked on a gesture (`on_user_event`), drawn where the run stopped — a sheet
 * with a dashed --warn edge and no fill, its letterhead the amber title block ("waiting on you", where
 * it would go, for how long), the sentence, and the button that delivers the move.
 *
 *   .sb-sheet.ss-waiting   dashed, --warn 34% into --line, no ground, no shadow
 *   .ss-wait-do            row, centred, gap 10, wrapping, 11 above; `.ss-wait-or` app 12/12.5 --dim
 */
function WaitingOn({ request, onDeliver }: { request: PendingUserEvent; onDeliver: () => void }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const to = advanceTargetOf(request);
  const waited = useElapsed(request.at, true) ?? 0;
  const sheet = sheetLookOf(t, look);
  const size = Number(t.scaled("size-data", 11 / 12)) || 11;
  const body = { voice: "app" as const, scale: 13 / 12.5 };
  const mono = { voice: "data" as const, scale: 1 };
  return (
    <View flexDirection="column" minWidth={0}>
      <View flexDirection="column" minWidth={0} borderWidth={sheet.width} borderStyle="dashed" borderColor={(look.palette === "contrast" ? t.v("rule") : t.mix(t.v("warn"), 34, t.v("line"))) as never} borderRadius={sheet.radius} overflow="hidden">
        <View flexDirection="column" alignItems="stretch" paddingTop={13} paddingHorizontal={15} paddingBottom={15} minWidth={0}>
          <View flexDirection="row" alignItems="baseline" gap={9} marginTop={-13} marginHorizontal={-15} marginBottom={13} paddingVertical={9} paddingHorizontal={15} backgroundColor={t.mix(t.v("warn"), 14, t.v("panel")) as never} {...(edge(t, { bottom: 1 }, t.mix(t.v("warn"), 30, t.v("line")), "dashed") as object)}>
            <Icon name="clock" size={size} color={String(t.v("warn"))} box={{ alignSelf: "center" }} />
            <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, ls: 0.09, upper: true, color: "warn" }} flexShrink={0}>
              waiting on you
            </Txt>
            <Txt spec={{ voice: "data", scale: 1, weight: 600, color: "warn" }} flexShrink={0}>
              {to !== undefined ? `→ ${to}` : request.event}
            </Txt>
            <Txt spec={{ voice: "data", scale: 11 / 12, color: "warn", tabular: true }} flexShrink={0} marginLeft="auto" paddingLeft={10} opacity={0.85}>
              {durationOf(waited)}
            </Txt>
          </View>
          <Txt spec={body}>
            {to !== undefined ? (
              <>
                Move this task to <Txt spec={mono}>{to}</Txt> to carry on. Nothing downstream runs until you do.
              </>
            ) : (
              <>
                This run is waiting for <Txt spec={mono}>{request.event}</Txt>.
              </>
            )}
          </Txt>
          {to !== undefined ? (
            <View flexDirection="row" alignItems="center" gap={10} flexWrap="wrap" marginTop={11}>
              <Button kind="primary" onPress={onDeliver}>
                {`Advance to ${to}`}
              </Button>
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>— or drag the card there on the board</Txt>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// `collapsed` is `SessionBands.tsx`'s now; exported from here too, where it has been found.
export { collapsed };

/** `p.empty`: a quiet sentence where there is nothing to draw. */
export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
      {children}
    </Txt>
  );
}

/**
 * `SettledGate`: a settled gate in its state's panel — the control as answered, who answered it when the
 * control conversation did, and the record behind a toggle (`.gate-record`: 12 above, its button 6 over
 * the record).
 */
function SettledGate({ call, node, taskId, project, services }: { call: ReadCall; node: InstanceNode; taskId: string; project: string | undefined; services?: Partial<ComponentServices> | undefined }): JSX.Element {
  const [record, setRecord] = useState(false);
  const pending = useMemo(() => settledGateOf(call, node, taskId, project), [call, node, taskId, project]);
  const answered = call.error === undefined && call.result !== undefined;
  return (
    <>
      <GateSurface key={answered ? "answered" : "open"} pending={pending} onSubmit={() => undefined} settled={answered ? { value: call.result } : { value: undefined }} plain services={services} />
      {answered && node.settledBy !== undefined ? (
        <AnsweredForYou
          by={node.settledBy}
          onAnswerYourself={() => void invoke("task:answerYourself", { taskId, at: node.settledBy!.at, ...(project !== undefined && project !== "" ? { project } : {}) }).catch(() => undefined)}
        />
      ) : null}
      <View marginTop={12} minWidth={0}>
        <View alignItems="flex-start" marginBottom={6}>
          <Button kind="quiet" onPress={() => setRecord((v) => !v)}>
            {record ? "Hide the record" : "Show the record"}
          </Button>
        </View>
        {record ? <CallBlock call={call} /> : null}
      </View>
    </>
  );
}

/**
 * `SilentState`: a state with nothing to read — what it called, or what went wrong, or its inputs.
 *
 *   .ss-call-head      row, centred, gap 7, 8 under; the Σ 13, --dim
 *   .ss-call-name      data 12/12, 600, --text; .ss-call-status data 10/12, 0.08em, upper, --warn
 *   .ss-slots          column, gap 4, 10 under (in a call)
 *   .ss-slot-name      data 11/12, --dim, 2 under; .ss-slot-value data 12/12, --text, ellipsed
 */
function SilentState({ node, records }: { node: InstanceNode; records: Record<string, OperationRecordView> }): JSX.Element {
  const t = useTokens();
  const failure = node.operation?.status === "failed" ? node.operation.reason : undefined;
  const calls = useMemo(() => callsOf(node, records), [node, records]);
  // `.ss-call + .ss-call`: 14 above, 12 inside, a --line over; a told line and a call 10 apart.
  const listed = calls.map((call, i) => {
    const told = toldOf(call) !== undefined;
    const before = i === 0 ? undefined : toldOf(calls[i - 1]!) !== undefined || told ? "told" : "call";
    return (
      <View key={i} minWidth={0} {...(before === "call" ? { marginTop: 14, paddingTop: 12, ...edge(t, { top: 1 }) } : before === "told" ? { marginTop: 10 } : {})}>
        <CallBlock call={call} />
      </View>
    );
  });
  if (failure !== undefined) {
    return (
      <>
        {/* `p.ss-fail`: the reason in the data voice, --bad, in a line of the body's font. */}
        <Txt spec={{ voice: "app", scale: 13 / 12.5 }} {...({ overflowWrap: "anywhere" } as object)}>
          <Txt spec={{ voice: "data", scale: 1, color: "bad", lineHeight: 13 / 12.5 * 1.5 * 12.5 / 12 }}>{collapsed(failure)}</Txt>
        </Txt>
        {listed}
      </>
    );
  }
  if (calls.length > 0) return <>{listed}</>;
  const slots = Object.entries(node.inputs ?? {});
  if (slots.length === 0) return <Empty>Nothing was bound to this run.</Empty>;
  return <Slots slots={slots} gap={10} provenance={node.inputProvenance} />;
}

function CallBlock({ call }: { call: ReadCall }): JSX.Element {
  const t = useTokens();
  const told = toldOf(call);
  if (told !== undefined) return <ToldLine told={told} />;
  const args = Object.entries(call.args);
  return (
    <View minWidth={0}>
      <View flexDirection="row" alignItems="center" gap={7} minWidth={0} marginBottom={8}>
        <Icon name="sigma" size={13} color={String(t.v("dim"))} />
        {/* `.ss-call-name.mono`: the size is the data voice's, the face the app's (`.mono` sets none). */}
        <Txt spec={{ voice: "app", scale: 1, weight: 600, color: "text" }} fontSize={t.scaled("size-data", 1)} lineHeight={t.replayed ? Number(t.scaled("size-data", 1.5)) : undefined} minWidth={0} flexShrink={1} title={call.ref ?? call.name}>
          {call.name ?? call.kind ?? "call"}
        </Txt>
        {call.status !== "completed" ? (
          <Txt spec={{ voice: "data", scale: 10 / 12, ls: 0.08, upper: true, color: "warn" }} flexShrink={0}>
            {call.status}
          </Txt>
        ) : null}
      </View>
      {args.length > 0 ? <Slots slots={args} gap={4} marginBottom={10} /> : null}
      {call.error !== undefined ? <ValueView value={call.error} label="error" /> : call.result !== undefined ? <ValueView value={call.result} label="returned" /> : null}
    </View>
  );
}

/**
 * `ToldLine`: an events automation's `notify`, settled — what it told you, and what about.
 *
 *   .ss-told        row, wrapping, baseline, gap 2 6; the bell at 0.95em, "told you:" --dim, the text,
 *                   and what it was about (`data-faint`: data 0.84, --tok-hint)
 */
function ToldLine({ told }: { told: { text: string; about?: string } }): JSX.Element {
  const body = { voice: "app" as const, scale: 13 / 12.5 };
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="baseline" rowGap={2} columnGap={6} minWidth={0}>
      <Txt spec={{ ...body, scale: (13 / 12.5) * 0.95 }} flexShrink={0} aria-hidden>
        🔔
      </Txt>
      <Txt spec={{ ...body, color: "dim" }} flexShrink={0}>
        told you:
      </Txt>
      <Txt spec={body} minWidth={0} {...({ overflowWrap: "anywhere" } as object)}>
        {told.text}
      </Txt>
      {told.about !== undefined ? (
        <Txt register="data-faint" minWidth={0} {...({ overflowWrap: "anywhere" } as object)}>
          · {told.about}
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * `.ss-slot-name` is an INLINE-BLOCK in a line of the body's font, so the line it stands in is taller
 * than it: its top sits where the two baselines meet, and the line ends at whichever bottom is lower.
 * Worked out as Blink does it — each font's ascent and descent rounded to whole pixels (DM Sans
 * 0.992 / 0.31, JetBrains Mono 1.02 / 0.3), the leading split around them.
 */
/**
 * `.prov`: how a value was settled (decision 0005 §4) — bound by wiring, inferred, or asked. A pill 6
 * after the name: data 600 at 10/12.5 on a 1.6 line, padding 0 6, 1px --line (inferred --accent, asked
 * --warn, each 40 / 45% into --line).
 */
function Provenance({ via }: { via: string }): JSX.Element {
  const t = useTokens();
  const hue = via === "inferred" ? { ink: "accent", edge: t.mix(t.v("accent"), 40, t.v("line")) } : via === "asked" ? { ink: "warn", edge: t.mix(t.v("warn"), 45, t.v("line")) } : { ink: "dim", edge: t.v("line") };
  return (
    <View flexShrink={0} marginLeft={6} paddingHorizontal={6} borderWidth={1} borderStyle="solid" borderRadius={999} borderColor={hue.edge as never}>
      <Txt spec={{ voice: "data", scale: (10 / 12.5) * (12.5 / 12), weight: 600, color: hue.ink, lineHeight: 1.6 }} fontSize={t.scaled("size-app", 10 / 12.5)}>
        {via}
      </Txt>
    </View>
  );
}

function slotLineOf(t: ReturnType<typeof useTokens>): { top: number; height: number } {
  const body = Number(t.scaled("size-app", 13 / 12.5)) || 13;
  const name = Number(t.scaled("size-data", 11 / 12)) || 11;
  const top = baselineOf(body, 0.992, 0.31) - baselineOf(name, 1.02, 0.3);
  return { top, height: Math.max(top + name * 1.5 + 2, body * 1.5) - Math.min(0, top) };
}

function Slots({ slots, gap, marginBottom = 0, provenance }: { slots: [string, unknown][]; gap: number; marginBottom?: number; provenance?: InstanceNode["inputProvenance"] | undefined }): JSX.Element {
  const t = useTokens();
  const line = slotLineOf(t);
  return (
    <View flexDirection="column" gap={gap} minWidth={0} marginBottom={marginBottom}>
      {slots.map(([name, value]) => (
        <View key={name} minWidth={0}>
          <View height={line.height} flexDirection="row" alignItems="flex-start">
            <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} marginTop={line.top}>
              {name}
            </Txt>
            {provenance?.[name] !== undefined ? <Provenance via={provenance[name]!.via} /> : null}
          </View>
          <Txt spec={{ voice: "data", scale: 1, color: "text" }} ellip minWidth={0} title={previewOf(value as never)}>
            {previewOf(value as never)}
          </Txt>
        </View>
      ))}
    </View>
  );
}

/** `.inline-gate`: a question or an approval hosted in the conversation — a 2px --accent rule over it, 12 above, 8 in. */
export function InlineHost({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View marginTop={12} paddingTop={8} minWidth={0} {...(edge(t, { top: 2 }, "accent") as object)}>
      {children}
    </View>
  );
}
