import { useEffect, useMemo, useRef, type JSX, type ReactNode } from "react";
import { Platform, ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View } from "@tamagui/core";
import { readCall, type InstanceNode, type OperationRecordView, type PendingInteraction, type ReadCall, type TaskDetail } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { paletteOfRun } from "@jaira/ui/rail";
import { bandsOf, instancesOf, mountPathOf, notesOf, pathFrom, piecesOf, recordAt, type BandNote, type SessionBand, type SessionPiece, type SessionSegment } from "@jaira/ui/sessionBands";
import { sessionKey } from "@jaira/ui/sessionCache";
import { keyOfPiece, metaOf, pageRowsOf, spanOf, summaryOf } from "@jaira/ui/sessionRows";
import { KIND_ICON, KIND_WORD, askingInstanceOf, headerToneOf, isAsking, surfaceKindOf, type HeaderTone, type SurfaceKind } from "@jaira/ui/stateSurface";
import { entriesOf, entriesOfPart, journalFor, markAnsweredQuestions, previewOf, signatureOf } from "@jaira/ui/transcript";
import { Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useLook, useTokens, type Look } from "../../tokens";
import { Uncopied } from "../../app/Uncopied";
import { GateSurface } from "./Gate";
import { Icon } from "./Icon";
import { RailedRows } from "./Rail";
import { Transcript } from "./SessionTranscript";

/** What a run's conversation is read from — the store's fields `App.tsx` hands `FileSurfaceContext`. */
export type TranscriptSource = Pick<FileSurfaceContext, "conversation" | "sessions" | "sessionHistory" | "records" | "liveTurn" | "onLoadSessions" | "shutStates" | "onToggleShutState" | "onSetShutStates" | "batches" | "userEvents"> & {
  /** Whether a cut can be offered — `context.onRewind` and `context.onFork` both there. */
  cuts: boolean;
};

/**
 * `runViews.tsx`'s `RunConversation`, its scroller and what is in it, universal (decision 0015): the
 * run's sessions as panels down the page (`sessionPanels.tsx`'s `SessionBandsView`), the notes between
 * them, and the rail beside it all. The page's rows are `pageRowsOf` (`sessionRows.ts`), the same as the
 * DOM's; the pieces, notes and palette are `sessionBands.ts`' and `rail.ts`'s.
 *
 * Copied: a band of one session, its gutter and sheet, a state's letterhead, an entered note, a state
 * that called a function (`SilentState`), and the transcript (`Transcript.tsx`). {@link Uncopied}: a
 * band of several sessions (columns or tabs), a fork mark, the torn edges of a paused or resumed
 * session, a settled gate, a parked transition (`WaitingOn`), a made/asked/moved note, an armed cut,
 * the origin seam, and the rewind and fork buttons (drawn as the room they take, invisible as the
 * DOM's are until a pointer arrives).
 *
 *   .run-convo      flex 1, scrolls, follows the live edge
 *   .sb             column, at least the scroller's height, --bg, padding 14 16 22
 */
export function RunTranscript({ detail, source, gate, onGate }: { detail: TaskDetail; source: TranscriptSource; gate?: PendingInteraction; onGate?: (value: unknown) => void }): JSX.Element {
  const t = useTokens();
  const parent = detail.instances[0];
  const { conversation, sessions, sessionHistory, records, liveTurn, onLoadSessions, shutStates, onToggleShutState, onSetShutStates } = source;
  const bands = useMemo(() => bandsOf(piecesOf(parent, sessionHistory), { batches: source.batches }), [parent, sessionHistory, source.batches]);
  const needed = useMemo(() => instancesOf(bands), [bands]);
  const palette = useMemo(() => paletteOfRun(detail.instances), [detail.instances]);
  const notes = useMemo(() => notesOf(conversation?.turns ?? [], parent), [conversation, parent]);
  const rootPath = useMemo(() => (parent === undefined ? "" : mountPathOf(detail.instances, parent.instanceId)), [detail, parent]);
  const askingHere = useMemo(() => (gate === undefined || onGate === undefined ? undefined : askingInstanceOf(detail.instances)), [gate, onGate, detail.instances]);
  const waits = useMemo(() => [...source.userEvents].filter((one) => one.taskId === detail.taskId), [source.userEvents, detail.taskId]);

  // Every panel is open, so every transcript in them is needed — fetched in one round.
  useEffect(() => {
    const missing = needed.filter((one) => sessions[sessionKey(one)] === undefined);
    if (missing.length > 0) onLoadSessions(missing);
  }, [needed, sessions, onLoadSessions]);

  // Follow the live edge (`useStickToBottom`): pinned to the end until the reader scrolls away from it.
  const scroller = useRef<ScrollView | null>(null);
  const following = useRef(true);
  const lastY = useRef(0);
  // Only a move UP lets go of the edge: content arriving does not move the offset, and the pin's own
  // scroll goes down — so neither can be mistaken for the reader leaving.
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    if (y + layoutMeasurement.height >= contentSize.height - 4) following.current = true;
    else if (y < lastY.current - 1) following.current = false;
    lastY.current = y;
  };

  const render = (piece: SessionPiece): ReactNode => {
    if (gate !== undefined && onGate !== undefined && isAsking(piece.node)) {
      if (gate.queued !== undefined && gate.offline !== undefined) return <Uncopied name="a gate answered offline" />;
      return <GateSurface pending={gate} onSubmit={onGate} />;
    }
    if (surfaceKindOf(piece.node) === "asked" && piece.node.operation !== undefined && !isAsking(piece.node)) {
      const cut = piece.node.status === "canceled" || piece.node.status === "failed" || piece.node.status === "timeout";
      if (piece.node.operation.status !== "running" || cut) return <Uncopied name="a settled gate" />;
    }
    const silent = piece.sessionId === undefined && surfaceKindOf(piece.node) !== "conversation";
    if (silent || piece.node.operation?.status === "failed") return <SilentState node={piece.node} records={records} />;
    const view = sessions[sessionKey(recordAt(piece))];
    if (view === undefined) return <Empty>Loading…</Empty>;
    const matches =
      liveTurn !== null &&
      (piece.sessionId !== undefined ? liveTurn.sessionId === piece.sessionId && liveTurn.seq === piece.seq : liveTurn.stateId === piece.node.stateId && piece.node.status === "running");
    const entries = entriesOfPart(markAnsweredQuestions(entriesOf(view, journalFor(conversation?.turns ?? [], piece.node.stateId), matches ? liveTurn : null), piece.node.answeredQuestions), piece.part);
    return <Transcript session={view} entries={entries} />;
  };

  const empty = bands.length === 0 && notes.length === 0;
  const page = empty ? undefined : pageRowsOf(bands, notes, rootPath);
  return (
    <ScrollView
      ref={scroller}
      {...(scrollbarProps(t) as object)}
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ flexGrow: 1 }}
      onScroll={onScroll}
      scrollEventThrottle={32}
      onContentSizeChange={() => {
        if (following.current) toEnd(scroller.current);
      }}
      onLayout={() => {
        if (following.current) toEnd(scroller.current);
      }}
    >
      <View flexGrow={1} flexDirection="column" backgroundColor={t.v("bg") as never} paddingTop={14} paddingHorizontal={16} paddingBottom={22}>
        {page === undefined ? (
          <Empty>This run has not entered a child yet.</Empty>
        ) : (
          <RailedRows
            steps={page.steps}
            palette={palette}
            wide={page.bands.some((band) => band.segments.length > 1)}
            renderStep={(i) => {
              const row = page.rows[i]!;
              if (row.kind === "note") return <NoteRow note={row.note} root={rootPath} cuts={source.cuts} />;
              return (
                <Band
                  band={row.band}
                  starter={(segment) => page.starters.get(segment.key)}
                  asking={askingHere}
                  shut={shutStates}
                  onToggle={onToggleShutState}
                  onSetShut={onSetShutStates}
                  scope={detail.taskId}
                  render={render}
                />
              );
            }}
          />
        )}
        {waits.length > 0 ? <Uncopied name="a parked transition (WaitingOn)" /> : null}
      </View>
    </ScrollView>
  );
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

/** `p.empty`: a quiet sentence where there is nothing to draw. */
export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
      {children}
    </Txt>
  );
}

/** What each kind of note says it is (`sessionPanels.tsx`'s `VERB`). */
const VERB: Record<BandNote["kind"], string> = { entered: "entered", transition: "entered", blocked: "could not enter", failure: "", made: "made", skipped: "skipped", moved: "", asked: "asked" };

/**
 * `NoteRow`: what happened between the panels — a state entered, a child that could not be. The rewind
 * and fork buttons are the room they take (`.sb-note .ts-rail`, 44 × 21, hidden at rest).
 *
 *   .sb-note          row, baseline, gap 8, padding 4, --size-app × 11.5/12.5, --bad (.step: --dim)
 *   .sb-note-icon     1em, centred; .sb-note-verb, .sb-note-state --dim, the state at most 30%, ellipsed
 */
function NoteRow({ note, root, cuts }: { note: BandNote; root: string; cuts: boolean }): JSX.Element {
  const t = useTokens();
  if ((note.kind === "made" && note.made !== undefined) || (note.kind === "asked" && note.asked !== undefined) || (note.kind === "moved" && note.moved !== undefined)) return <Uncopied name={`a ${note.kind} note`} />;
  const moved = note.kind === "entered" || note.kind === "transition";
  const skipped = note.kind === "skipped";
  const where =
    note.keys !== undefined && note.keys.length > 1
      ? [pathFrom(note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "", root), note.keys.join(", ")].filter((part) => part !== "").join(" → ")
      : pathFrom(note.path, root);
  const ink = moved || skipped ? "dim" : "bad";
  const size = t.scaled("size-app", 11.5 / 12.5);
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  return (
    <View role="note" flexDirection="row" alignItems="baseline" gap={8} padding={4} minWidth={0}>
      <Icon name={moved ? "choice" : skipped ? "workflow" : "alert"} size={typeof size === "number" ? size : 11.5} color={String(t.v(ink))} box={{ alignSelf: "center" }} />
      {VERB[note.kind] === "" ? null : (
        <Txt spec={words} flexShrink={0}>
          {VERB[note.kind]}
        </Txt>
      )}
      {skipped && note.text.length > 0 ? <Txt spec={{ ...words, color: ink }} minWidth={0} flexShrink={1}>{note.text}</Txt> : null}
      {where === "" ? null : (
        <Txt spec={words} ellip flexShrink={0} maxWidth="30%" title={note.stateId ?? where}>
          {where}
        </Txt>
      )}
      {note.kind === "entered" || skipped || note.text.length === 0 ? null : (
        <Txt spec={{ ...words, color: ink }} minWidth={0} flexShrink={1}>
          {note.kind === "blocked" ? `: ${note.text}` : note.text}
        </Txt>
      )}
      {cuts && moved ? <View width={44} height={21} marginLeft="auto" alignSelf="center" flexShrink={0} /> : null}
    </View>
  );
}

/** `Band`: one slice of wall clock. A single session is its sheet; several are {@link Uncopied}. */
function Band({
  band,
  starter,
  asking,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  band: SessionBand;
  starter: (segment: SessionSegment) => SessionPiece | undefined;
  asking: string | undefined;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  scope: string;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  if (band.segments.length !== 1) return <Uncopied name="concurrent sessions (columns or tabs)" />;
  const segment = band.segments[0]!;
  return (
    <View position="relative" flexDirection="column" width="100%" minWidth={0}>
      <Sheet segment={segment} starter={starter(segment)} asking={asking} shut={shut} onToggle={onToggle} onSetShut={onSetShut} scope={scope} render={render} />
    </View>
  );
}

/**
 * `Sheet`: one session's panel — its name in the grey above it, then what it said.
 *
 *   .sb-gutter         row, centred, gap 8, padding 0 4 4 (.bare: 2 under); .solo is the fold
 *   .sb-gut-chev       the chevron, turned a quarter when open
 *   .sb-session        --size-app × 11/12.5, --dim, ellipsed
 *   .sb-workflow       button.link: data at --size-data × 11/12, --accent, ellipsed, shrinks
 *   .sb-span           --size-app × 11/12.5, --dim, tabular, pushed right, 8 before
 *   .sb-foldall        padding 3 5, a transparent 1px edge, --size-app × 10.5/12.5, --dim; its word
 *                      hidden (0 wide) until hovered
 *   .sb-sheet          --panel, 1px --line, radius 12, 0 1 3 rgba(15, 20, 30, .06) (dark: 0 0 0 .35)
 *   .sb-body           column, padding 13 15 15
 */
function Sheet({
  segment,
  starter,
  asking,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  segment: SessionSegment;
  starter: SessionPiece | undefined;
  asking: string | undefined;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  scope: string;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  const t = useTokens();
  const keys = segment.pieces.map((piece) => keyOfPiece(piece, scope));
  const allShut = keys.length > 0 && keys.every((key) => shut.has(key));
  const toggleAll = (): void => onSetShut(keys, !allShut);
  const only = segment.pieces.length === 1 ? segment.pieces[0] : undefined;
  const solo = only !== undefined && surfaceKindOf(only.node) === "conversation";
  const surface = only !== undefined && segment.sessionId === undefined && surfaceKindOf(only.node) !== "conversation";
  const small = { voice: "app" as const, scale: 11 / 12.5, color: "dim" };
  // The workflow's own link: describing it beside the run is the Files view's panel, not copied yet.
  // `button.link.sb-workflow.ellip`: a BUTTON, so an inline-flex that centres its text — squeezed, the
  // name overflows both sides and is clipped there, with no ellipsis (the text is a flex item, which
  // `text-overflow` does not reach). Drawn the same way here.
  const workflow =
    starter !== undefined ? (
      <View flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" justifyContent="center">
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} flexShrink={0} whiteSpace="nowrap" title={`${starter.node.stateId} — describe this run of it`}>
          {starter.node.stateId}
        </Txt>
      </View>
    ) : null;
  const span = spanOf(segment);
  const sheet = sheetLookOf(t, useLook());
  return (
    <View flexDirection="column" minWidth={0}>
      {surface && workflow !== null ? (
        <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={4} paddingBottom={2} minWidth={0}>
          {workflow}
        </View>
      ) : null}
      {!surface ? (
        <Gutter solo={solo} onPress={toggleAll}>
          {solo ? (
            <View flexShrink={0} transform={allShut ? [] : [{ rotate: "90deg" }]}>
              <Icon name="chevron" size={Number(t.scaled("size-app", 13 / 12.5)) || 13} color={String(t.v("dim"))} />
            </View>
          ) : null}
          {segment.sessionId !== undefined ? (
            <Txt spec={small} ellip minWidth={0} flexShrink={1} title={segment.sessionId}>
              {segment.sessionId}
            </Txt>
          ) : (
            <Txt spec={{ ...small, italic: true }}>no conversation</Txt>
          )}
          {workflow}
          {span !== "" ? (
            <Txt spec={{ ...small, tabular: true }} flexShrink={0} marginLeft="auto" paddingLeft={8}>
              {span}
            </Txt>
          ) : null}
          {solo ? null : (
            <Press
              onPress={toggleAll}
              label={allShut ? "Expand all" : "Collapse all"}
              flexShrink={0}
              flexDirection="row"
              alignItems="center"
              gap={5}
              paddingVertical={3}
              paddingHorizontal={5}
              borderWidth={1}
              borderStyle="solid"
              borderRadius={Number(t.v("control-radius-sm")) || 6}
              box={({ hovered }) => ({ borderColor: hovered ? t.v("line") : "rgba(0, 0, 0, 0)", backgroundColor: hovered ? t.v("panel-2") : "rgba(0, 0, 0, 0)" })}
            >
              {({ hovered }) => (
                <>
                  <Icon name={allShut ? "unfold" : "fold"} size={Number(t.scaled("size-app", 10.5 / 12.5)) || 10.5} color={String(hovered ? t.v("text") : t.v("dim"))} />
                  {hovered ? (
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "text" }} marginLeft={6} numberOfLines={1}>
                      {allShut ? "expand all" : "collapse all"}
                    </Txt>
                  ) : (
                    // The word is there at rest, 0 wide: it only takes its line's height.
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} width={0} opacity={0} numberOfLines={1} overflow="hidden">
                      {allShut ? "expand all" : "collapse all"}
                    </Txt>
                  )}
                </>
              )}
            </Press>
          )}
        </Gutter>
      ) : null}
      {solo && allShut ? null : (
        <View
          flexDirection="column"
          minWidth={0}
          backgroundColor={t.v("panel") as never}
          borderWidth={sheet.width}
          borderStyle="solid"
          borderColor={t.v(sheet.edge) as never}
          borderRadius={sheet.radius}
          overflow="hidden"
          {...({ boxShadow: sheet.shadow } as object)}
        >
          {segment.resumed ? <Uncopied name="a resumed session's torn edge" /> : null}
          <View flexDirection="column" alignItems="stretch" paddingTop={13} paddingHorizontal={15} paddingBottom={15} minWidth={0}>
            {segment.pieces.map((piece, i) =>
              solo ? (
                <View key={`${piece.node.instanceId}:${piece.seq ?? "—"}`} minWidth={0}>
                  {render(piece)}
                </View>
              ) : (
                <Piece
                  key={`${piece.node.instanceId}:${piece.seq ?? "—"}`}
                  piece={piece}
                  first={i === 0}
                  afterShut={i > 0 && shut.has(keyOfPiece(segment.pieces[i - 1]!, scope))}
                  open={!shut.has(keyOfPiece(piece, scope))}
                  onToggle={() => onToggle(keyOfPiece(piece, scope))}
                  render={render}
                  asking={asking}
                />
              ),
            )}
          </View>
          {segment.paused ? <Uncopied name="a paused session's torn edge" /> : null}
        </View>
      )}
    </View>
  );
}

/** `.sb-gutter`: the whole line is the fold on a solo sheet (a role=button div), else a plain row. */
function Gutter({ solo, onPress, children }: { solo: boolean; onPress: () => void; children: ReactNode }): JSX.Element {
  const box = { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 4, minWidth: 0 } as const;
  return solo ? (
    <Press onPress={onPress} {...box}>
      {children}
    </Press>
  ) : (
    <View {...box}>{children}</View>
  );
}

/**
 * `.sb-sheet`'s frame, and the rules the palettes put on it:
 *
 *   :root[data-theme="dark"] .sb-sheet                   0 1 3 rgba(0, 0, 0, .35)
 *   :root[data-palette="contrast"] .sb-sheet             1.5px --rule, 3px 3px 0 --rule, radius 4
 *   :root:is([data-palette="pastel"], …-rail) .sb-sheet  radius 16
 */
function sheetLookOf(t: ReturnType<typeof useTokens>, look: Look): { width: number; edge: string; radius: number; shadow: string } {
  if (look.palette === "contrast") return { width: 1.5, edge: "rule", radius: 4, shadow: `3px 3px 0px ${String(t.v("rule"))}` };
  const shadow = look.scheme === "dark" ? "0px 1px 3px rgba(0, 0, 0, 0.35)" : "0px 1px 3px rgba(15, 20, 30, 0.06)";
  return { width: 1, edge: "line", radius: look.palette === "pastel" || look.palette === "pastel-rail" ? 16 : 12, shadow };
}

/**
 * `Piece` → `StateBlock` + `StateHeader`: one state inside a session's panel — its letterhead, and its
 * transcript under it while open.
 *
 *   .lh               row, baseline, gap 9, margin 0 0 11, padding 0 0 7, a --line under; data at
 *                     --size-data × 11/12, --dim (hover --text)
 *   .st-block + .st-block > .lh   20 above (12 after a folded one; 16 for a title block)
 *   .lh.shut          no margin under, 8 padding under
 *   .lh.tb            margin −13 −15 13, padding 9 15, --panel-2 — the title block of a state going on;
 *                     accent: --accent 12% into --panel, its rule --accent 28% into --line, all --accent;
 *                     amber: --warn 14%, a dashed rule --warn 30%; red: --bad 11%, --bad 26%
 *   .lh-chev          centred, turned −90° when shut; .lh-ico centred
 *   .lh-kind          600, 0.09em, upper, --size-data × 10/12
 *   .lh-name          600, --text, --size-data (12/12)
 *   .lh-label         app voice, --size-app × 12/12.5, ellipsed
 *   .lh-meta          pushed right, 10 before, tabular, 0.85 opaque
 */
function Piece({ piece, first, afterShut, open, onToggle, render, asking }: { piece: SessionPiece; first: boolean; afterShut: boolean; open: boolean; onToggle: () => void; render: (piece: SessionPiece) => ReactNode; asking: string | undefined }): JSX.Element {
  const t = useTokens();
  const node = piece.node;
  const kind = surfaceKindOf(node);
  const sig = signatureOf(node);
  const tone = headerToneOf(node, kind, asking !== undefined && asking === node.instanceId);
  const meta = metaOf(node);
  const summary = summaryOf(piece);
  return (
    <View flexDirection="column" alignItems="stretch" minWidth={0} data-instance={node.instanceId}>
      <Letterhead
        open={open}
        kind={kind}
        tone={tone}
        name={sig.name}
        label={sig.label}
        summary={summary}
        meta={meta}
        status={kind === "conversation" ? node.status : undefined}
        onToggle={onToggle}
        above={first ? 0 : tone !== undefined ? 16 : afterShut ? 12 : 20}
        t={t}
      />
      {open ? render(piece) : null}
    </View>
  );
}

function Letterhead({
  open,
  kind,
  tone,
  name,
  label,
  summary,
  meta,
  status,
  onToggle,
  above,
  t,
}: {
  open: boolean;
  kind: SurfaceKind | undefined;
  tone: HeaderTone;
  name: string;
  label: string | undefined;
  summary: string | undefined;
  meta: string;
  status: InstanceNode["status"] | undefined;
  onToggle: () => void;
  above: number;
  t: ReturnType<typeof useTokens>;
}): JSX.Element {
  const word = kind !== undefined && kind !== "conversation" ? KIND_WORD[kind] : undefined;
  const glyph = kind !== undefined && kind !== "conversation" ? KIND_ICON[kind] : undefined;
  const hue = tone === "accent" ? "accent" : tone === "amber" ? "warn" : tone === "red" ? "bad" : undefined;
  const ground = tone === "accent" ? t.mix(t.v("accent"), 12, t.v("panel")) : tone === "amber" ? t.mix(t.v("warn"), 14, t.v("panel")) : tone === "red" ? t.mix(t.v("bad"), 11, t.v("panel")) : undefined;
  const rule = tone === "accent" ? t.mix(t.v("accent"), 28, t.v("line")) : tone === "amber" ? t.mix(t.v("warn"), 30, t.v("line")) : tone === "red" ? t.mix(t.v("bad"), 26, t.v("line")) : t.v("line");
  const size = Number(t.scaled("size-data", 11 / 12)) || 11;
  return (
    <Press
      onPress={onToggle}
      aria-expanded={open}
      alignSelf="stretch"
      flexDirection="row"
      alignItems="baseline"
      // A button's `justify-content: center` (the base rule): when the line cannot fit, it overflows
      // both sides equally rather than only the right.
      justifyContent="center"
      gap={9}
      minWidth={0}
      {...(tone !== undefined
        ? { marginTop: above === 0 ? -13 : above, marginHorizontal: -15, marginBottom: open ? 13 : 0, paddingVertical: 9, paddingHorizontal: 15, backgroundColor: ground }
        : { marginTop: above, marginBottom: open ? 11 : 0, paddingBottom: open ? 7 : 8 })}
      {...(edge(t, { bottom: 1 }, String(rule), tone === "amber" ? "dashed" : "solid") as object)}
    >
      {({ hovered }) => {
        const ink = hue ?? (hovered ? "text" : "dim");
        return (
          <>
            {/* `.lh-chev` is a block holding the glyph INLINE: it stands on the baseline of a line of the
                header's own font, and that line is what is centred — not the glyph. */}
            <View alignSelf="center" flexShrink={0} height={size * 1.5} transform={open ? [] : [{ rotate: "-90deg" }]}>
              <Icon name="chevron" size={size} color={String(t.v(hue ?? "dim"))} box={{ marginTop: baselineOf(size, 1.02, 0.3) - size }} />
            </View>
            {glyph !== undefined ? <Icon name={glyph} size={size} color={String(t.v(ink))} box={{ alignSelf: "center" }} /> : null}
            {glyph === undefined && status !== undefined ? <Uncopied name="the outcome dot" /> : null}
            {word !== undefined ? (
              <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, ls: 0.09, upper: true, color: ink }} flexShrink={0}>
                {word}
              </Txt>
            ) : null}
            <Txt spec={{ voice: "data", scale: 1, weight: 600, color: hue ?? "text" }} flexShrink={0}>
              {name}
            </Txt>
            {open ? (
              label !== undefined && label.length > 0 ? (
                <Txt spec={{ voice: "app", scale: 12 / 12.5, color: ink }} ellip minWidth={0} flexShrink={1}>
                  {label}
                </Txt>
              ) : null
            ) : summary !== undefined && summary.length > 0 ? (
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
                {summary}
              </Txt>
            ) : null}
            {meta.length > 0 ? (
              <Txt spec={{ voice: "data", scale: 11 / 12, color: ink, tabular: true }} flexShrink={0} marginLeft="auto" paddingLeft={10} opacity={0.85}>
                {meta}
              </Txt>
            ) : null}
          </>
        );
      }}
    </Press>
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
  const failure = node.operation?.status === "failed" ? node.operation.reason : undefined;
  const calls = useMemo(() => (node.calls ?? []).map((call) => records[call.operationId]).filter((row): row is OperationRecordView => row !== undefined).map(readCall), [node.calls, records]);
  if (failure !== undefined) return <Uncopied name="a failed state" />;
  if (calls.length > 0) return <>{calls.map((call, i) => <CallBlock key={i} call={call} />)}</>;
  const slots = Object.entries(node.inputs ?? {});
  if (slots.length === 0) return <Empty>Nothing was bound to this run.</Empty>;
  return <Slots slots={slots} gap={4} />;
}

function CallBlock({ call }: { call: ReadCall }): JSX.Element {
  const t = useTokens();
  if (call.name === "notify") return <Uncopied name="a notify call" />;
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
      {call.error !== undefined || call.result !== undefined ? <Uncopied name="a call's returned value (ValueView)" /> : null}
    </View>
  );
}

/**
 * `.ss-slot-name` is an INLINE-BLOCK in a line of the body's font, so the line it stands in is taller
 * than it: its top sits where the two baselines meet, and the line ends at whichever bottom is lower.
 * Worked out as Blink does it — each font's ascent and descent rounded to whole pixels (DM Sans
 * 0.992 / 0.31, JetBrains Mono 1.02 / 0.3), the leading split around them.
 */
/** Where the baseline sits in a line of 1.5 × `size`, as Blink places it (ascent and descent rounded). */
function baselineOf(size: number, ascent: number, descent: number): number {
  const a = Math.round(size * ascent);
  const d = Math.round(size * descent);
  return (size * 1.5 - (a + d)) / 2 + a;
}

function slotLineOf(t: ReturnType<typeof useTokens>): { top: number; height: number } {
  const body = Number(t.scaled("size-app", 13 / 12.5)) || 13;
  const name = Number(t.scaled("size-data", 11 / 12)) || 11;
  const top = baselineOf(body, 0.992, 0.31) - baselineOf(name, 1.02, 0.3);
  return { top, height: Math.max(top + name * 1.5 + 2, body * 1.5) - Math.min(0, top) };
}

function Slots({ slots, gap, marginBottom = 0 }: { slots: [string, unknown][]; gap: number; marginBottom?: number }): JSX.Element {
  const t = useTokens();
  const line = slotLineOf(t);
  return (
    <View flexDirection="column" gap={gap} minWidth={0} marginBottom={marginBottom}>
      {slots.map(([name, value]) => (
        <View key={name} minWidth={0}>
          <View height={line.height} alignItems="flex-start">
            <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} marginTop={line.top}>
              {name}
            </Txt>
          </View>
          <Txt spec={{ voice: "data", scale: 1, color: "text" }} ellip minWidth={0} title={previewOf(value as never)}>
            {previewOf(value as never)}
          </Txt>
        </View>
      ))}
    </View>
  );
}
