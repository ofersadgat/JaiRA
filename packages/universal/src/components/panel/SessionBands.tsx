import { Fragment, useCallback, useContext, useRef, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { formatTokens, type ContextReading, type InstanceNode, type MadeBatch, type MadeTask, type MoveQuestionView, type TaskOrigin } from "@jaira/shared/browser";
import { pathFrom, placeOf, type BandNote, type SessionBand, type SessionPiece, type SessionSegment } from "@jaira/ui/sessionBands";
import { addedOf, cutNameOf, keyOfPiece, markedRowsOf, metaOf, pageRowsOf, sideName, sideOf, spanOf, summaryOf } from "@jaira/ui/sessionRows";
import { KIND_ICON, KIND_WORD, headerToneOf, surfaceKindOf, type HeaderTone, type SurfaceKind } from "@jaira/ui/stateSurfaceModel";
import { signatureOf } from "@jaira/ui/transcript";
import { InkContext, Press, Txt, appCh, edge, lengthToken, padToken, useHover } from "../../primitives";
import { useLook, useTokens, type Look, type Tokens } from "../../tokens";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { anchorRectOf } from "../floats/anchor";
import { Icon } from "./Icon";
import { RailedRows } from "./Rail";
import { InNoteContext } from "./noteContext";
import { useSpyLit, useSpyRow } from "./rowSpy";
import { OutcomeNote } from "./WorkRows";
import { Svg } from "./Svg";
import { OneLine } from "./OneLine";

/**
 * The conversation drawn as one panel per session — bands down the page, the notes on the grey between
 * them, the rail beside it all. The page's rows are `pageRowsOf` and `markedRowsOf` (`sessionRows.ts`),
 * what a fork side is called `sideName`, the pieces and notes `sessionBands.ts`'. How it looks:
 *
 *   a band             relative column; several sessions at once are columns, or tabs (its rows 4 apart)
 *   columns            the sessions side by side, equal, top-aligned, gap 12
 *   the layout toggle  absolute, top −2, right 0, a 1px --line box, radius 6, clipped, hidden until the
 *                      band is hovered; its buttons padding 3 7 on --panel, --dim (on: --panel-2, --text),
 *                      the glyph 13
 *   the tabs           row, gap 2, 60 right; a tab at most 220, 1px --line but the bottom, radius 8 8 0 0,
 *                      --bg, padding 4 12, data 11/12 --dim (on: --panel, --text)
 *   a sheet            --panel, 1px --line, radius 12 (a torn side 2), 0 1 3 rgba(15,20,30,.06)
 *   a torn edge        row, centred, gap 8, padding 3 10, --dim, --accent 5%; a --rule between it and the
 *                      body; its teeth an 8px path, --accent 45% into --line, 1.25 wide; the label app
 *                      10.5/12.5, 0.02em, lower case (the id data, --text)
 *   a fork mark        row, centred, gap 10 (torn: margin 14 0 12)
 *   its chip           row, gap 6, padding 2 9, a transparent 1px edge, radius 7, app 10.5/12.5, 0.02em,
 *                      lower case, --dim; hovered or open --accent 30% into --line, --panel-2, --text;
 *                      glyphs 11, the first and `fork:` (600) --accent 70% into --dim
 *   an armed cut       as a transcript's cut line (`SessionTranscript.tsx`), margin 2 4 6; the rows
 *                      under it at .35
 *   a lit sheet        where a fork's "go to the other side" landed: --accent 55% into --line,
 *                      a 3px ring of --accent 14%, for 1.2s (the contrast sheet keeps its frame, the dark
 *                      one its shadow)
 *   a made row         the verb, the runs (links, their standing, "waits for" in a pill), the state; an
 *                      adoption's chevron is a button, and its nest the adopted task's history
 *
 * A lane's right-click (a long press on a phone) is the entered row's two verbs as a menu (`onContext`),
 * and the rows a bookmark lands on — an entered row, a letterhead, a solo sheet's body — are filed with
 * the conversation's spy (`rowSpy.ts`) for it to measure.
 */

/** What each kind of note says it is. */
const VERB: Record<BandNote["kind"], string> = { entered: "entered", transition: "entered", blocked: "could not enter", failure: "", made: "made", skipped: "skipped", moved: "", asked: "asked" };

/** What the machine did to make the runs. */
const MADE_VERB: Record<MadeBatch["kind"], string> = { split: "split off", task: "made", adopt: "adopted", started: "started" };

/**
 * Text as `white-space: normal` lays it out: every run of spaces and line breaks one space. A `Text`
 * keeps a newline as a break, so words meant to reflow are collapsed before they are drawn.
 */
export const collapsed = (text: string): string => text.replace(/[ \t\n\r\f]+/g, " ");

/** The two verbs of a cut, offered on an entered row. */
export interface CutOffer {
  rewind: (note: BandNote) => void;
  fork: (note: BandNote) => void;
}

/** What a note's state is CALLED in a sentence about it — `sessionRows.ts`' `cutNameOf`. */
export { cutNameOf };

/** The whole conversation: bands down the page, in the order they happened. */
export function SessionBands({
  bands: given,
  notes,
  root,
  render,
  palette,
  asking,
  shut,
  onToggle,
  onSetShut,
  scope,
  cuts,
  armed,
  origin,
  onSelectTask,
  adopted,
  moveQuestion,
  onOpenWorkflow,
  readingOf,
  empty,
}: {
  bands: readonly SessionBand[];
  notes: readonly BandNote[];
  root: string;
  render: (piece: SessionPiece) => ReactNode;
  palette?: ReadonlyMap<string, string> | undefined;
  asking?: string | undefined;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  scope: string;
  /** The two verbs of a cut, on every entered row. `true`: only the room they take (no host to do them). */
  cuts?: CutOffer | boolean | undefined;
  armed?: { seq: number; at: number } | undefined;
  origin?: (TaskOrigin & { onGo?: (() => void) | undefined }) | undefined;
  onSelectTask?: ((taskId: string) => void) | undefined;
  adopted?: ((taskId: string) => ReactNode) | undefined;
  moveQuestion?: ((asked: MoveQuestionView) => ReactNode) | undefined;
  /** Describe the workflow a panel's conversation was opened by. Absent ⇒ the gutter names no workflow. */
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  /** How full a piece's conversation was after its last turn — each letterhead's `+30k`. */
  readingOf?: ((piece: SessionPiece) => ContextReading | undefined) | undefined;
  empty?: ReactNode;
}): JSX.Element {
  const goTo = useGoTo();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  if (given.length === 0 && notes.length === 0) return <>{empty ?? null}</>;
  const page = pageRowsOf(given, notes, root);
  const marked = markedRowsOf(page, notes, armed, origin);
  const { cutRow, doomedFrom } = marked;
  const rowClass = (i: number): string | undefined => (i === cutRow ? "is-cut" : doomedFrom >= 0 && i >= doomedFrom ? "doomed" : undefined);
  // A lane's menu (a right-click, a long press on a phone): the same two verbs its entered row offers.
  const offer = typeof cuts === "object" ? cuts : undefined;
  const onContext =
    offer === undefined
      ? undefined
      : (key: string, point: { x: number; y: number }): void => {
          const note = page.laneNotes.get(key);
          if (note === undefined) return;
          const name = cutNameOf(note, root);
          setMenu({
            ...point,
            items: [
              { label: `Rewind to before ${name}`, note: "deletes it and everything after", onSelect: () => offer.rewind(note) },
              { label: `Fork before ${name}`, note: "a new task from here", onSelect: () => offer.fork(note) },
            ],
          });
        };
  return (
    <>
    <RailedRows
      steps={marked.steps}
      palette={palette}
      wide={page.bands.some((band) => band.segments.length > 1)}
      {...(armed !== undefined || origin !== undefined ? { rowClass } : {})}
      {...(onContext !== undefined ? { onContext } : {})}
      renderStep={(i) => {
        const item = marked.rows[i]!;
        if (item.kind === "cut") return <CutRow states={item.states} />;
        if (item.kind === "origin") return <OriginMark origin={origin!} onGo={origin!.onGo} />;
        const row = page.rows[item.index]!;
        if (row.kind === "note") return <NoteRow note={row.note} root={root} cuts={cuts} onSelectTask={onSelectTask} adopted={adopted} moveQuestion={moveQuestion} />;
        return <Band band={row.band} starters={page.starters} forks={page.forks} goTo={goTo} onOpenWorkflow={onOpenWorkflow} readingOf={readingOf} asking={asking} shut={shut} onToggle={onToggle} onSetShut={onSetShut} scope={scope} render={render} />;
      }}
    />
    {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/**
 * Going to the other side of a fork: every side is already drawn on the page, so the mark's job is to
 * take the reader to the one picked — scrolled into view and lit for 1.2s, since the sides are the same
 * state saying nearly the same thing. The sheets register themselves by position (`data-fork-place`),
 * which is what a side knows about its siblings.
 *
 * Web only for now: a phone has no `scrollIntoView`, and the jump would have to be measured against
 * the transcript's own scroller (`measureLayout` and its `scrollTo`), which the bands do not hold — so
 * there the chip offers the sides and goes nowhere.
 */
interface GoTo {
  lit: string | null;
  place: (place: string, el: unknown) => void;
  show: (place: string) => void;
}

function useGoTo(): GoTo {
  const [lit, setLit] = useState<string | null>(null);
  const places = useRef(new Map<string, { scrollIntoView?: (options: object) => void }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const place = useCallback((at: string, el: unknown) => {
    if (el === null) places.current.delete(at);
    else places.current.set(at, el as { scrollIntoView?: (options: object) => void });
  }, []);
  const show = useCallback((at: string) => {
    if (!isWeb) return;
    const found = places.current.get(at);
    if (typeof found?.scrollIntoView !== "function") return;
    found.scrollIntoView({ block: "start", behavior: "smooth" });
    setLit(at);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLit(null), 1200);
  }, []);
  return { lit, place, show };
}

/** The counted line under an armed rewind's entry — a dashed rule each side of the words. */
function CutRow({ states }: { states: number }): JSX.Element {
  const t = useTokens();
  const rule = <View flex={1} {...(edge(t, { top: 1 }, t.mix(t.v("bad"), 60, t.v("line")), "dashed") as object)} />;
  return (
    <View role="note" flexDirection="row" alignItems="center" gap={10} marginTop={2} marginHorizontal={4} marginBottom={6}>
      {rule}
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "bad", ls: 0.02 }} numberOfLines={1}>
        {`${states} state${states === 1 ? "" : "s"} below this line will be deleted`}
      </Txt>
      {rule}
    </View>
  );
}

/** One of a cut's two icon buttons on an entered row — padding 4, radius --control-radius-sm, the glyph 13. */
function Act({ icon, label, title, onPress }: { icon: "rewind" | "choice"; label: string; title: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} label={label} title={title} padding={4} borderRadius={lengthToken(t, "control-radius-sm", 6)} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
      {({ hovered }) => <Icon name={icon} size={13} color={String(t.v(hovered ? "text" : "dim"))} />}
    </Press>
  );
}

/**
 * `NoteRow`: what happened between the panels — a state entered, a child that could not be, a skip, and
 * (their own rows) what a fan-out made, a move's question, what a workflow tool did.
 *
 *   the row           row, baseline, gap 8, padding 4, --size-app × 11.5/12.5, --bad (a step taken or
 *                     skipped: --dim)
 *   its icon          1em, centred; the verb and the state --dim, the state at most 30%, ellipsed
 *   the cut's verbs   at the end, shown while the row is hovered
 */
export function NoteRow({
  note,
  root,
  cuts,
  onSelectTask,
  adopted,
  moveQuestion,
}: {
  note: BandNote;
  root: string;
  cuts?: CutOffer | boolean | undefined;
  onSelectTask?: ((taskId: string) => void) | undefined;
  adopted?: ((taskId: string) => ReactNode) | undefined;
  moveQuestion?: ((asked: MoveQuestionView) => ReactNode) | undefined;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  // `data-entered`: what a bookmark lands on — the row where the run went INTO the state.
  const entered = note.kind === "entered" ? note.instanceId : undefined;
  const spy = useSpyRow(entered, "entered");
  const moved = note.kind === "entered" || note.kind === "transition";
  const skipped = note.kind === "skipped";
  const where =
    note.keys !== undefined && note.keys.length > 1
      ? [pathFrom(note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "", root), note.keys.join(", ")].filter((part) => part !== "").join(" → ")
      : pathFrom(note.path, root);
  if (note.kind === "made" && note.made !== undefined) return <MadeRow note={note} made={note.made} where={where} onSelectTask={onSelectTask} adopted={adopted} />;
  if (note.kind === "asked" && note.asked !== undefined) {
    // A move's question: the question UI and nothing around it, 8 under.
    return (
      <View minWidth={0} marginBottom={8} data-asked={note.asked.requestId}>
        {moveQuestion !== undefined ? moveQuestion(note.asked) : null}
      </View>
    );
  }
  if (note.kind === "moved" && note.moved !== undefined) return <OutcomeNote outcome={note.moved} />;
  const ink = moved || skipped ? "dim" : "bad";
  const size = t.scaled("size-app", 11.5 / 12.5);
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const offer = typeof cuts === "object" ? cuts : undefined;
  return (
    <View role="note" flexDirection="row" alignItems="baseline" gap={8} padding={4} minWidth={0} {...(hover as object)} {...(entered !== undefined ? { "data-entered": entered } : {})} {...(spy !== undefined ? { ref: spy } : {})}>
      <Icon name={moved ? "choice" : skipped ? "workflow" : "alert"} size={typeof size === "number" ? size : 11.5} color={String(t.v(ink))} box={{ alignSelf: "center" }} />
      {VERB[note.kind] === "" ? null : (
        <Txt spec={words} flexShrink={0}>
          {VERB[note.kind]}
        </Txt>
      )}
      {skipped && note.text.length > 0 ? (
        <Txt spec={{ ...words, color: ink }} minWidth={0} flexShrink={1}>
          {collapsed(note.text)}
        </Txt>
      ) : null}
      {where === "" ? null : (
        <Txt spec={words} ellip flexShrink={0} maxWidth="30%" title={note.stateId ?? where}>
          {where}
        </Txt>
      )}
      {note.kind === "entered" || skipped || note.text.length === 0 ? null : note.kind === "transition" && !isWeb ? (
        // A transition's text is where it went — a state's name, one line on the desktop at any width a
        // panel has; a phone would wrap it a letter short of its end.
        <OneLine spec={{ ...words, color: ink }} flexShrink={0}>
          {collapsed(note.text)}
        </OneLine>
      ) : (
        <Txt spec={{ ...words, color: ink }} minWidth={0} flexShrink={1}>
          {collapsed(note.kind === "blocked" ? `: ${note.text}` : note.text)}
        </Txt>
      )}
      {cuts !== undefined && cuts !== false && moved ? (
        <View flexDirection="row" alignItems="center" gap={2} marginLeft="auto" alignSelf="center" flexShrink={0} opacity={hovered && offer !== undefined ? 1 : 0}>
          {offer !== undefined ? (
            <>
              <Act icon="rewind" label={`Rewind to before ${cutNameOf(note, root)}`} title={`Rewind to before ${cutNameOf(note, root)} — it and everything after it are deleted, and the run enters it again`} onPress={() => offer.rewind(note)} />
              <Act icon="choice" label={`Fork before ${cutNameOf(note, root)}`} title={`Fork before ${cutNameOf(note, root)} — a new task that keeps everything before it and starts by entering it`} onPress={() => offer.fork(note)} />
            </>
          ) : (
            <View width={44} height={21} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A run's standing in words: held, what it is still holding for, or its status. */
function standingOf(run: MadeTask): string {
  const waiting = run.holding > 0 ? `waiting for ${run.holding} ${run.holding === 1 ? "task" : "tasks"}` : undefined;
  if (run.held === true) return waiting === undefined ? "held" : `held · ${waiting}`;
  return waiting ?? run.status;
}

/**
 * `MadeRow`: the runs a fan-out made of its elements — the verb, every run but this task's own (its
 * title as the link, its standing, a pill on each one this task waits for), and the mount. An adoption
 * unfolds the adopted task's history under the line.
 *
 *   the row            wrapping, centred;  the runs: row, wrapping, baseline, gap 0 4
 *   "waits for"        0.85em, --dim, 1px --line, round, padding 0 6;  the link of a run waited for 600
 *   a run's link       at most 24ch, ellipsed, hover underlined;  its standing --dim
 *   the nest           the whole row wide, margin 4 0 8 18, padding-left 8, 2px --accent 45% into --line
 */
function MadeRow({ note, made, where, onSelectTask, adopted }: { note: BandNote; made: MadeBatch; where: string; onSelectTask?: ((taskId: string) => void) | undefined; adopted?: ((taskId: string) => ReactNode) | undefined }): JSX.Element {
  const t = useTokens();
  const others = made.runs.filter((run) => !run.self);
  const expands = made.kind === "adopt" && adopted !== undefined && others.length === 1;
  const [open, setOpen] = useState(true);
  const size = Number(t.scaled("size-app", 11.5 / 12.5)) || 11.5;
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  return (
    <View role="note" flexDirection="row" flexWrap="wrap" alignItems="center" gap={8} padding={4} minWidth={0} data-made={others.map((run) => run.taskId).join(" ")}>
      {expands ? (
        // The fold: a button (--panel-2, a --line ring, --control-radius, padding --control-pad) round
        // the glyph at the note's 1em, the whole of it turned while folded.
        <Press
          onPress={() => setOpen((v) => !v)}
          label={open ? `fold ${others[0]!.title}` : `unfold ${others[0]!.title}`}
          title={open ? "fold what this task did before it was adopted" : "show what this task did before it was adopted"}
          {...({ "aria-expanded": open } as object)}
          flexShrink={0}
          alignSelf="center"
          flexDirection="row"
          alignItems="center"
          justifyContent="center"
          paddingVertical={padToken(t, "control-pad", [3, 10])[0]}
          paddingHorizontal={padToken(t, "control-pad", [3, 10])[1]}
          borderWidth={1}
          borderStyle="solid"
          borderColor={t.v("line") as never}
          borderRadius={lengthToken(t, "control-radius", 7)}
          backgroundColor={t.v("panel-2") as never}
          transform={open ? [] : [{ rotate: "-90deg" }]}
        >
          <Icon name="chevron" size={size} color={String(t.v("dim"))} />
        </Press>
      ) : (
        <Icon name="choice" size={size} color={String(t.v("dim"))} box={{ alignSelf: "center" }} />
      )}
      <Txt spec={words} flexShrink={0}>
        {MADE_VERB[made.kind]}
      </Txt>
      <View flexDirection="row" flexWrap="wrap" alignItems="baseline" columnGap={4} minWidth={0} flexShrink={1}>
        {others.map((run, i) => (
          <View key={run.taskId} flexDirection="row" alignItems="baseline" gap={4} minWidth={0}>
            {i > 0 ? <Txt spec={words}>,</Txt> : null}
            {run.waitsFor ? (
              <View borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={999} paddingHorizontal={6}>
                {/* The line height as a factor (unitless 1.5) on web: Blink floors its product, and the
                    pill's leading then falls under its words (22 device pixels as pixels put half of it above). */}
                <Txt spec={{ ...words, scale: (11.5 / 12.5) * 0.85 }} {...(isWeb ? { lineHeight: "1.5" } : {})}>
                  waits for
                </Txt>
              </View>
            ) : null}
            <Press onPress={() => onSelectTask?.(run.taskId)} title={`open ${run.title} (${run.taskId})`} minWidth={0} flexShrink={1}>
              {({ hovered }) => (
                <Txt spec={{ ...words, color: "dim", weight: run.waitsFor ? 600 : 400 }} ellip maxWidth={appCh(t, 11.5 / 12.5, 24) as number} textDecorationLine={hovered && onSelectTask !== undefined ? "underline" : "none"}>
                  {run.title}
                </Txt>
              )}
            </Press>
            <Txt spec={words} flexShrink={0}>
              · {standingOf(run)}
            </Txt>
          </View>
        ))}
      </View>
      {where === "" ? null : (
        <Txt spec={words} ellip flexShrink={0} maxWidth="30%" title={note.stateId ?? where}>
          {where}
        </Txt>
      )}
      {expands && open ? (
        // `flex-basis: 100%` and its margin on a line of the row: it shrinks to what the margin leaves.
        <View flexBasis="100%" flexShrink={1} minWidth={0} marginTop={4} marginBottom={8} marginLeft={18} paddingLeft={8} {...(edge(t, { left: 2 }, t.mix(t.v("accent"), 45, t.v("line"))) as object)}>
          {/* Inside the note: its --dim reaches every word in the history that sets no colour. */}
          <InkContext.Provider value="dim">
            <InNoteContext.Provider value={true}>{adopted!(others[0]!.taskId)}</InNoteContext.Provider>
          </InkContext.Provider>
        </View>
      ) : null}
    </View>
  );
}

/** The teeth of a torn edge: an 8px zigzag path, repeated across the width it is given. */
function Zig({ t }: { t: Tokens }): JSX.Element {
  const [width, setWidth] = useState(0);
  let d = "";
  for (let x = 0; x < width + 8; x += 8) d += `${x === 0 ? "M" : "L"}${x} 6.5 L${x + 4} 1.5 `;
  return (
    <View flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={12} height={8} overflow="hidden" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? <Svg width={width} height={8} viewBox={`0 0 ${width} 8`} strokeWidth={1.25} linecap="butt" linejoin="miter" shapes={[{ kind: "path", d: `${d}L${Math.ceil((width + 8) / 8) * 8} 6.5`, stroke: String(t.mix(t.v("accent"), 45, t.v("line"))), strokeWidth: 1.25 }]} /> : null}
    </View>
  );
}

/** `TearBar`: a torn edge with a sentence in the middle of it. */
export function TearBar({ kind, id }: { kind: "paused" | "resumed"; id: string }): JSX.Element {
  const t = useTokens();
  const label = { voice: "app" as const, scale: 10.5 / 12.5, ls: 0.02, color: "dim" };
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={3}
      paddingHorizontal={10}
      backgroundColor={t.mix(t.v("accent"), 5, "transparent") as never}
      {...(edge(t, kind === "resumed" ? { bottom: 1 } : { top: 1 }, "rule") as object)}
    >
      <Zig t={t} />
      <Txt spec={label} flexShrink={0} numberOfLines={1}>
        {`${kind} session `}
        <Txt spec={{ ...label, voice: "data", color: "text", scale: (Number(t.scaled("size-app", 10.5 / 12.5)) || 10.5) / (Number(t.scaled("size-data", 1)) || 12) }}>
          {id.toLowerCase()}
        </Txt>
      </Txt>
      <Zig t={t} />
    </View>
  );
}

/** One side of a fork, as {@link ForkMark} draws it. */
export interface ForkSide {
  key: string;
  label: string;
  note?: string;
}

/**
 * A fork's chip: quiet at rest, its box on hover and while its menu is open. `side` is its words in
 * parts, each a text node of its own (`{at + 1} of {sides.length} — {side.label}` is five): Blink shapes
 * each node apart, and one string set the glyphs after each join a fraction off the reference pictures.
 */
function ForkChip({ kind, side, open, disabled = false, onPress, chevron, title }: { kind: string; side: readonly string[]; open: boolean; disabled?: boolean; onPress: (from: unknown) => void; chevron: boolean; title: string }): JSX.Element {
  const t = useTokens();
  const face = { voice: "app" as const, scale: 10.5 / 12.5, ls: 0.02 };
  const mark = t.mix(t.v("accent"), 70, t.v("dim"));
  return (
    <Press
      onPress={(e) => onPress((e as unknown as { currentTarget?: unknown }).currentTarget)}
      disabled={disabled}
      title={title}
      label={`${kind} ${side.join("")}`}
      flexGrow={0}
      flexShrink={1}
      minWidth={0}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingVertical={2}
      paddingHorizontal={9}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={7}
      box={({ hovered }) => {
        const on = !disabled && (hovered || open);
        return { borderColor: on ? t.mix(t.v("accent"), 30, t.v("line")) : "transparent", backgroundColor: on ? t.v("panel-2") : "transparent" };
      }}
    >
      {({ hovered }) => {
        const ink = !disabled && (hovered || open) ? "text" : "dim";
        return (
          <>
            <Icon name="choice" size={11} color={String(mark)} />
            <Txt spec={{ ...face, weight: 600, color: String(mark) }} flexShrink={0} numberOfLines={1}>
              {kind}
            </Txt>
            <Txt spec={{ ...face, color: ink }} ellip minWidth={0} flexShrink={1}>
              {side.map((part, i) => (
                <Fragment key={i}>{part.toLowerCase()}</Fragment>
              ))}
            </Txt>
            {chevron ? <Icon name="chevron" size={11} color={String(t.v(ink))} /> : null}
          </>
        );
      }}
    </Press>
  );
}

/** `ForkMark`: one place a conversation divided — a torn edge (or none, in a gutter) and the chip that picks a side. */
export function ForkMark({ sides, shown, onShow, note, torn = true }: { sides: readonly ForkSide[]; shown: string; onShow: (key: string) => void; note?: string | undefined; torn?: boolean }): JSX.Element | null {
  const t = useTokens();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const at = Math.max(
    0,
    sides.findIndex((side) => side.key === shown),
  );
  const side = sides[at];
  if (side === undefined || sides.length < 2) return null;
  return (
    <View flexDirection="row" alignItems="center" gap={10} minWidth={0} {...(torn ? { marginTop: 14, marginBottom: 12 } : { flexShrink: 1 })}>
      {torn ? <Zig t={t} /> : null}
      <ForkChip
        kind="fork:"
        side={[String(at + 1), " of ", String(sides.length), " — ", side.label]}
        open={menu !== null}
        chevron
        title={note ?? "the other sides of this fork"}
        onPress={(from) => {
          const box = anchorRectOf(from);
          setMenu({
            x: box === null ? 0 : Math.max(0, box.left + (box.right - box.left) / 2 - MENU_WIDTH / 2),
            y: box === null ? 0 : box.bottom + 3,
            ...(note !== undefined ? { title: note } : {}),
            items: sides.map((one) => ({ label: one.label, ...(one.note !== undefined ? { note: one.note } : {}), checked: one.key === shown, onSelect: () => onShow(one.key) })),
          });
        }}
      />
      {torn ? <Zig t={t} /> : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** `OriginMark`: where a forked task came from — the same torn edge and chip, a way back rather than a choice. */
export function OriginMark({ origin, onGo }: { origin: TaskOrigin; onGo?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const from = origin.title ?? "a task since deleted";
  return (
    <View role="note" flexDirection="row" alignItems="center" gap={10} minWidth={0} marginTop={14} marginBottom={12}>
      <Zig t={t} />
      <ForkChip
        kind="forked from:"
        side={[from, ", ", origin.label]}
        open={false}
        disabled={onGo === undefined}
        chevron={onGo !== undefined}
        title={onGo === undefined ? `forked from ${from}, ${origin.label}` : `go to ${from}, where this was forked from`}
        onPress={() => onGo?.()}
      />
      <Zig t={t} />
    </View>
  );
}

/** What a tab is called: the session id, or the state that ran in no conversation at all. */
function tabNameOf(segment: SessionSegment): string {
  return segment.sessionId ?? segment.pieces[0]?.node.childKey ?? segment.pieces[0]?.node.stateId ?? segment.key;
}

/** `Band`: one slice of wall clock — one session's sheet, or several laid out across (columns or tabs). */
function Band({
  band,
  starters,
  forks,
  goTo,
  onOpenWorkflow,
  readingOf,
  asking,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  band: SessionBand;
  starters: Map<string, SessionPiece>;
  forks: Map<string, SessionPiece[]>;
  goTo: GoTo;
  onOpenWorkflow: ((piece: SessionPiece) => void) | undefined;
  readingOf: ((piece: SessionPiece) => ContextReading | undefined) | undefined;
  asking: string | undefined;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  scope: string;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  const t = useTokens();
  const [layout, setLayout] = useState<"columns" | "tabs" | null>(null);
  const [tab, setTab] = useState(0);
  const [hovered, hover] = useHover();
  const sheet = (segment: SessionSegment, named = true): JSX.Element => (
    <Sheet key={segment.key} segment={segment} named={named} starter={onOpenWorkflow === undefined ? undefined : starters.get(segment.key)} onOpenWorkflow={onOpenWorkflow} readingOf={readingOf} forks={forks} goTo={goTo} asking={asking} shut={shut} onToggle={onToggle} onSetShut={onSetShut} scope={scope} render={render} />
  );
  if (band.segments.length === 1) {
    return (
      <View position="relative" flexDirection="column" width="100%" minWidth={0}>
        {sheet(band.segments[0]!)}
      </View>
    );
  }
  const chosen = layout ?? (band.segments.length <= 2 ? "columns" : "tabs");
  const shown = Math.min(tab, band.segments.length - 1);
  const toggle = (which: "columns" | "tabs", first: boolean): JSX.Element => (
    <Press
      onPress={() => setLayout(which)}
      title={which === "columns" ? "Side by side" : "Tabbed"}
      {...({ "aria-pressed": chosen === which } as object)}
      flexDirection="row"
      alignItems="center"
      paddingVertical={3}
      paddingHorizontal={7}
      backgroundColor={t.v(chosen === which ? "panel-2" : "panel") as never}
      {...(first ? {} : (edge(t, { left: 0 }) as object))}
    >
      <Icon name={which} size={13} color={String(t.v(chosen === which ? "text" : "dim"))} />
    </Press>
  );
  return (
    // Tabbed, the band's rows (the tabs, the sheet) are 4 apart.
    <View position="relative" flexDirection="column" width="100%" minWidth={0} {...(chosen === "tabs" ? { gap: 4 } : {})} {...(hover as object)}>
      <View position="absolute" top={-2} right={0} zIndex={1} flexDirection="row" borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden" opacity={hovered || !isWeb ? 1 : 0}>
        {toggle("columns", true)}
        {toggle("tabs", false)}
      </View>
      {chosen === "tabs" ? (
        <>
          <View role="tablist" flexDirection="row" gap={2} minWidth={0} paddingRight={60}>
            {band.segments.map((segment, i) => (
              <Press
                key={segment.key}
                role="tab"
                onPress={() => setTab(i)}
                {...({ "aria-selected": i === shown } as object)}
                flexGrow={0}
                flexShrink={1}
                minWidth={0}
                maxWidth={220}
                paddingVertical={4}
                paddingHorizontal={12}
                borderTopLeftRadius={8}
                borderTopRightRadius={8}
                backgroundColor={t.v(i === shown ? "panel" : "bg") as never}
                {...(edge(t, { top: 1, right: 1, left: 1 }) as object)}
              >
                <Txt spec={{ voice: "data", scale: 11 / 12, color: i === shown ? "text" : "dim" }} ellip textAlign="center">
                  {tabNameOf(segment)}
                </Txt>
              </Press>
            ))}
          </View>
          {sheet(band.segments[shown]!, false)}
        </>
      ) : (
        <View flexDirection="row" alignItems="flex-start" gap={12} minWidth={0}>
          {band.segments.map((segment) => (
            <View key={segment.key} flex={1} flexBasis={0} minWidth={0}>
              {sheet(segment)}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * `Sheet`: one session's panel — its name in the grey above it (with the fork it is a side of), then
 * what it said, between the torn edges of a session another interrupted.
 *
 *   the gutter         row, centred, gap 8, padding 0 4 4 (2 under over a state that ran in no
 *                      conversation); on a solo sheet the whole line is the fold
 *   its chevron        turned a quarter when open
 *   the session id     --size-app × 11/12.5, --dim, ellipsed
 *   the workflow link  data at --size-data × 11/12, --accent, shrinks; squeezed, clipped at both ends
 *   the span           --size-app × 11/12.5, --dim, tabular, pushed right, 8 before
 *   fold all           padding 3 5, a transparent 1px edge, --size-app × 10.5/12.5, --dim; its word
 *                      hidden (0 wide) until hovered
 *   the body           column, padding 13 15 15
 */
function Sheet({
  segment,
  named,
  starter,
  onOpenWorkflow,
  readingOf,
  forks,
  goTo,
  asking,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  segment: SessionSegment;
  named: boolean;
  starter: SessionPiece | undefined;
  onOpenWorkflow: ((piece: SessionPiece) => void) | undefined;
  readingOf: ((piece: SessionPiece) => ContextReading | undefined) | undefined;
  forks: Map<string, SessionPiece[]>;
  goTo: GoTo;
  asking: string | undefined;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  scope: string;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  const t = useTokens();
  const side = sideOf(segment, forks);
  const keys = segment.pieces.map((piece) => keyOfPiece(piece, scope));
  const allShut = keys.length > 0 && keys.every((key) => shut.has(key));
  const toggleAll = (): void => onSetShut(keys, !allShut);
  const only = segment.pieces.length === 1 ? segment.pieces[0] : undefined;
  const solo = only !== undefined && surfaceKindOf(only.node) === "conversation";
  const surface = only !== undefined && segment.sessionId === undefined && surfaceKindOf(only.node) !== "conversation";
  // What each state ADDED to the conversation (`sessionRows.ts`' `addedOf`).
  const added = addedOf(segment.pieces, readingOf);
  const small = { voice: "app" as const, scale: 11 / 12.5, color: "dim" };
  // The workflow's link, centred in its box: squeezed, the name overflows both sides and is clipped
  // there, with no ellipsis.
  const workflow =
    starter !== undefined ? (
      // A pressable TEXT, not a Press: on a solo sheet the whole gutter is the fold, and a button in a button is not allowed.
      <View flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" justifyContent="center">
        <OneLine onPress={() => onOpenWorkflow?.(starter)} {...({ cursor: "pointer" } as object)} spec={{ voice: "data", scale: 11 / 12, color: "accent" }} flexShrink={0} title={`${starter.node.stateId} — describe this run of it`}>
          {starter.node.stateId}
        </OneLine>
      </View>
    ) : null;
  const span = spanOf(segment);
  // The gutter's chevron is 1em of the text around it: the body's 13, or a note's 11.5 in an adoption's nest.
  const chev = Number(t.scaled("size-app", (useContext(InNoteContext) ? 11.5 : 13) / 12.5)) || 13;
  const look = useLook();
  const sheet = sheetLookOf(t, look);
  // Lit where a fork's jump landed; the contrast sheet's frame and the dark one's shadow outrank it.
  const lit = side !== undefined && goTo.lit === side.place && look.palette !== "contrast";
  // A cut edge is not a corner: the torn side squared (radius 2).
  const radii =
    segment.resumed || segment.paused
      ? {
          borderTopLeftRadius: segment.resumed ? 2 : sheet.radius,
          borderTopRightRadius: segment.resumed ? 2 : sheet.radius,
          borderBottomLeftRadius: segment.paused ? 2 : sheet.radius,
          borderBottomRightRadius: segment.paused ? 2 : sheet.radius,
        }
      : { borderRadius: sheet.radius };
  return (
    <View flexDirection="column" minWidth={0} {...(side !== undefined ? { "data-fork-place": side.place, ref: (el: unknown) => goTo.place(side.place, el) } : {})}>
      {named && surface && workflow !== null ? (
        <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={4} paddingBottom={2} minWidth={0}>
          {workflow}
        </View>
      ) : null}
      {named && !surface ? (
        <Gutter solo={solo && side === undefined} onPress={toggleAll}>
          {solo ? (
            // With a fork chip in the gutter the line cannot be one button (a button in a button): the fold is the chevron.
            side !== undefined ? (
              <Press onPress={toggleAll} flexShrink={0} transform={allShut ? [] : [{ rotate: "90deg" }]}>
                <Icon name="chevron" size={chev} color={String(t.v("dim"))} />
              </Press>
            ) : (
              <View flexShrink={0} transform={allShut ? [] : [{ rotate: "90deg" }]}>
                <Icon name="chevron" size={chev} color={String(t.v("dim"))} />
              </View>
            )
          ) : null}
          {segment.sessionId !== undefined ? (
            <Txt spec={small} ellip minWidth={0} flexShrink={1} title={segment.sessionId}>
              {segment.sessionId}
            </Txt>
          ) : (
            <Txt spec={{ ...small, italic: true }}>no conversation</Txt>
          )}
          {workflow}
          {side !== undefined ? (
            <ForkMark
              torn={false}
              sides={side.sides.map((one) => ({ key: placeOf(one)!, label: sideName(one), ...(one.sessionId !== undefined ? { note: one.sessionId } : {}) }))}
              shown={side.place}
              onShow={goTo.show}
              note="the position was already taken, so every attempt after the first branched"
            />
          ) : null}
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
          borderColor={(lit ? t.mix(t.v("accent"), 55, t.v("line")) : t.v(sheet.edge)) as never}
          {...radii}
          overflow="hidden"
          {...({ boxShadow: lit && look.scheme !== "dark" ? `0px 0px 0px 3px ${String(t.mix(t.v("accent"), 14, "transparent"))}` : sheet.shadow } as object)}
          {...(lit && isWeb ? { style: { transition: "box-shadow 0.4s ease-out, border-color 0.4s ease-out" } } : {})}
        >
          {segment.resumed && segment.sessionId !== undefined ? <TearBar kind="resumed" id={segment.sessionId} /> : null}
          <View flexDirection="column" alignItems="stretch" paddingTop={13} paddingHorizontal={15} paddingBottom={15} minWidth={0}>
            {segment.pieces.map((piece, i) =>
              solo ? (
                <Bare key={`${piece.node.instanceId}:${piece.seq ?? "—"}`} id={piece.node.instanceId}>
                  {render(piece)}
                </Bare>
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
                  added={added.get(piece)}
                />
              ),
            )}
          </View>
          {segment.paused && segment.sessionId !== undefined ? <TearBar kind="paused" id={segment.sessionId} /> : null}
        </View>
      )}
    </View>
  );
}

/**
 * A solo sheet's body, stamped like a letterhead (`data-instance`) so a bookmark to its state lands
 * somewhere — and lit where one just did (radius 8, a 3px ring of --accent 14%, for 1.2s).
 */
function Bare({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const spy = useSpyRow(id, "instance");
  const lit = useSpyLit(id);
  return (
    <View
      minWidth={0}
      data-instance={id}
      {...(spy !== undefined ? { ref: spy } : {})}
      {...(lit ? ({ borderRadius: 8, boxShadow: `0px 0px 0px 3px ${String(t.mix(t.v("accent"), 14, "transparent"))}`, ...(isWeb ? { style: { transition: "box-shadow 0.4s ease-out" } } : {}) } as object) : {})}
    >
      {children}
    </View>
  );
}

/** A sheet's gutter: the whole line is the fold on a solo sheet (one `Press`), else a plain row. */
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
 * A sheet's frame, and what a look changes of it:
 *
 *   dark                   the shadow 0 1 3 rgba(0, 0, 0, .35)
 *   contrast               1.5px --rule, a hard shadow 3px 3px 0 --rule, radius 4
 *   pastel, pastel-rail    radius 16
 */
export function sheetLookOf(t: Tokens, look: Look): { width: number; edge: string; radius: number; shadow: string } {
  if (look.palette === "contrast") return { width: 1.5, edge: "rule", radius: 4, shadow: `3px 3px 0px ${String(t.v("rule"))}` };
  const shadow = look.scheme === "dark" ? "0px 1px 3px rgba(0, 0, 0, 0.35)" : "0px 1px 3px rgba(15, 20, 30, 0.06)";
  return { width: 1, edge: "line", radius: look.palette === "pastel" || look.palette === "pastel-rail" ? 16 : 12, shadow };
}

/**
 * One state inside a session's panel — its letterhead (`Letterhead`), and its transcript under it while
 * open.
 *
 *   the letterhead    row, baseline, gap 9, margin 0 0 11, padding 0 0 7, a --line under; data at
 *                     --size-data × 11/12, --dim (hover --text)
 *   after another     20 above (12 after a folded one; 16 for a title block)
 *   shut              no margin under, 8 padding under
 *   a title block     margin −13 −15 13, padding 9 15 — the letterhead of a state going on;
 *                     accent: --accent 12% into --panel, its rule --accent 28% into --line, all --accent;
 *                     amber: --warn 14%, a dashed rule --warn 30%; red: --bad 11%, --bad 26%
 *   the chevron       centred, turned −90° when shut; the kind's glyph centred
 *   the kind          600, 0.09em, upper, --size-data × 10/12
 *   the name          600, --text, --size-data (12/12)
 *   the label         app voice, --size-app × 12/12.5, ellipsed
 *   the meta          pushed right, 10 before, tabular, 0.85 opaque
 */
function Piece({ piece, first, afterShut, open, onToggle, render, asking, added }: { piece: SessionPiece; first: boolean; afterShut: boolean; open: boolean; onToggle: () => void; render: (piece: SessionPiece) => ReactNode; asking: string | undefined; added: number | undefined }): JSX.Element {
  const t = useTokens();
  const node = piece.node;
  const kind = surfaceKindOf(node);
  const sig = signatureOf(node);
  const tone = headerToneOf(node, kind, asking !== undefined && asking === node.instanceId);
  const meta = metaOf(node);
  const summary = summaryOf(piece);
  const spy = useSpyRow(node.instanceId, "instance");
  return (
    <View flexDirection="column" alignItems="stretch" minWidth={0} data-instance={node.instanceId} {...(spy !== undefined ? { ref: spy } : {})}>
      <Letterhead
        open={open}
        kind={kind}
        tone={tone}
        name={sig.name}
        label={sig.label}
        summary={summary}
        meta={meta}
        added={added}
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
  added,
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
  /** Tokens this state added to its conversation — drawn at the right, before the time, open or folded. */
  added: number | undefined;
  status: InstanceNode["status"] | undefined;
  onToggle: () => void;
  above: number;
  t: Tokens;
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
      // Centred, as a button centres what is in it: when the line cannot fit, it overflows both sides
      // equally rather than only the right.
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
            {/* The chevron stands on the baseline of a line of the header's own font, and that line is
                what is centred — not the glyph. */}
            <View alignSelf="center" flexShrink={0} height={size * 1.5} transform={open ? [] : [{ rotate: "-90deg" }]}>
              <Icon name="chevron" size={size} color={String(t.v(hue ?? "dim"))} box={{ marginTop: baselineOf(size, 1.02, 0.3) - size }} />
            </View>
            {glyph !== undefined ? <Icon name={glyph} size={size} color={String(t.v(ink))} box={{ alignSelf: "center" }} /> : null}
            {/* The status dot: 6 round, centred, --dim — the same dot whatever the status. */}
            {glyph === undefined && status !== undefined ? <View width={6} height={6} borderRadius={3} alignSelf="center" flexShrink={0} backgroundColor={t.v("dim") as never} /> : null}
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
            {meta.length > 0 || added !== undefined ? (
              // The meta, with the added count in it: the data face, --dim whatever the tone, 10 before the time.
              <View flexDirection="row" alignItems="baseline" flexShrink={0} marginLeft="auto" paddingLeft={10} opacity={0.85}>
                {added !== undefined ? (
                  <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", tabular: true }} marginRight={10} title={`this state added ${formatTokens(added)} tokens to the conversation`}>
                    +{formatTokens(added, true)}
                  </Txt>
                ) : null}
                {meta.length > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: ink, tabular: true }}>{meta}</Txt> : null}
              </View>
            ) : null}
          </>
        );
      }}
    </Press>
  );
}

/** Where the baseline sits in a line of 1.5 × `size`, as Blink places it (ascent and descent rounded). */
export function baselineOf(size: number, ascent: number, descent: number): number {
  const a = Math.round(size * ascent);
  const d = Math.round(size * descent);
  return (size * 1.5 - (a + d)) / 2 + a;
}
