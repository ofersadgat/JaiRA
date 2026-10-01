import { Fragment, createContext, useContext, useEffect, useReducer, useRef, useState, type DragEvent as ReactDragEvent, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Animated, Pressable, ScrollView, type View as HostView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { BoardCard, BoardColumn, BoardView, NextMove } from "@jaira/shared/browser";
import { canPickUp, columnDropOf, connectDragOf, CONFIRM_YES, type ColumnDrop, type ConnectDrop, type MoveQuestion } from "@jaira/ui/boardDrag";
import { archivedSplitOf, drillTargetOf, LANE_LABEL, laneRunsOf, type LaneEntry } from "@jaira/ui/boardModel";
import type { ConnectAsk, ConnectDrag } from "@jaira/ui/connectDrag";
import { NO_DRAG_OFFERS, type DragOffers } from "@jaira/ui/taskDrag";
import { Press, Txt, edge, useHover } from "../primitives";
import { useLook, useTokens, type Look, type Tokens } from "../tokens";
import { ConnectPop, Kind } from "./ConnectPop";
import { Button } from "./settings/Button";
import { Lift } from "./Lift";
import { ghostAt, ghostOf, ghostScrolled, useEdgeScroll, useLiftTargets, type EdgeScroller, type Ghost } from "./liftTargets";
import { claimed, TaskCard } from "./TaskCard";

/**
 * A board level (DESIGN §11.1): child states as columns, the tasks in them as cards (`TaskCard`), split
 * into lanes, archived ones held at each column's foot. The columns stand in the order the children RUN
 * in, never the transitions': a guard that jumps backwards must not reorder what is read left to right.
 * `numbered` is off for the root listing, whose workflows are siblings with no order; `trays` is off
 * where a level should not list work that is in none of its columns. A column is a box and a card is not:
 * a column is a place a task moves between, a card one item in it. How it looks, look by look
 * (`columnStyle` decides it):
 *
 *   the body                     column, gap 14, padding 10
 *   the columns                  row, gap 10, stretch; the root listing wraps with a 12 row gap
 *   a column                     flex 1 0 210, at most 320; --panel-2, 1px --line, radius 9; hover --rule,
 *                                selected --accent
 *   its heading                  row, baseline, gap 7, padding 6 10, --panel-3, 1px --line under, radius
 *                                8 8 0 0; selected --fill-ghost-selected (classic only: a named palette's
 *                                heading keeps its own ground)
 *   its body                     column, flex 1, padding 6; empty, a "—" in --dim, padding 2 4 6
 *   name / count / number        data-title, ellipsised / app-secondary, tabular, pushed right / data-num
 *   any named palette            the track: --track ground, --track-edge; the heading on --track with no
 *                                rule under it and 8 above; the body 4 7 8
 *   hairline                     the heading keeps a --line rule, 4 below
 *   contrast                     square, 1.5 edge; unless line buckets or lanes, the heading an inverted
 *                                band
 *   pastel, pastel-rail          radius 16, the heading 16 16 0 0
 *   blueprint                    dashed, radius 2; the heading on --bg over a 1px --rule, 2 2 0 0; the
 *                                board's body on 16px graph paper (--grid)
 *   line buckets                 no box (transparent, square, hover and selected alike); the heading on
 *                                --bg over a 2px --line (--rule hovered, --accent selected), 3 either
 *                                side, 6 below; the body 0 1 6
 *   lanes                        each column its lane colour (six, in turn): the ground and the heading at
 *                                --lane-pct over --bg, the heading's rule 35% over --line, the name and
 *                                number in --lane-ink over --lane-deep, 700; with line buckets, the ground
 *                                clear and the rule the lane's own
 *   a lane and its heading       a box per lane; the heading a row, centred, gap 8, 10 above 6 below: the
 *                                label (app-label), a 1px --line rule taking the slack, the count (data-num
 *                                at 400); finished and not-started lanes 0.72, 1 hovered
 *   the archived foot            a row, gap 8, 2 above, padding 4 2, --dim at 11.5/12.5, "N archived", a
 *                                --line rule, Show/Hide; hovered --fill-ghost-hover, --text
 *   the tray                     "At this level": an uppercase heading (11/12.5, bold, .09em, 8 below)
 *                                over cards 210 wide, wrapped with a gap of 8, lanes a row each
 *
 * The sticky column heading: on web `position: sticky`. React Native has no sticky but a ScrollView's
 * direct children (`stickyHeaderIndices`), and a heading here is deep inside a wrapping row; so on a
 * phone the scroller that holds the board (`BoardColumn`) hands its scroll down (`StickyScroll`) and each
 * heading (`StickyHead`) is moved by it on the native driver — held at the scroller's top once its
 * column's top has passed it, and let go at its column's foot, as sticky does.
 *
 * Dragging a card (decision 0005): picked up where a waiting rule offered it a move (`dragOffers`) or it
 * can be connected (`connect.ask`), every column that would take it dashed in the accent, the one under
 * the pointer filled, with the DROP PREVIEW under its cards (`ConnectPop`); the drop answers the wait
 * (`onTaskDrop`) or commits the connect, or puts the move table's question in that column first. What a
 * drop means is `boardDrag.ts`'s. How it shows:
 *
 *   a column that would take it  dashed, --accent, in every palette (a line bucket's is a 1px dashed box,
 *                                radius 9, it having no edge of its own)
 *   the one under the pointer    --fill-ghost-selected — except a line bucket in classic, a named line
 *                                bucket selected or hovered, and lanes, which keep their own ground
 *   a card that can be lifted    grab (`TaskCard`)
 *
 * On web the gesture is HTML5 drag: the card is `draggable` (`TaskCard`) and a column takes
 * `dragover`/`dragleave`/`drop`. On a phone it is a long press and a pan (`Lift`): the columns are
 * measured when the card is lifted, the one under the finger is `over`, a picture of the card follows the
 * finger over the board, and letting go lands it — or, not having moved, is the long press.
 *
 * The right-click menus: a card's (`onTaskMenu`) and a column's (`onColumnMenu`), at the pointer, the
 * column's only where no card took the click (`claimed`). On a phone the gesture is a long press, and the
 * menu's Open is what a long press did before.
 */

/** What a drop needs. */
export type DragProps = {
  /** The moves waiting transitions are offering, by task (`on_user_event`); none by default. */
  dragOffers?: DragOffers;
  /** A card was dropped on a column that was offering it a place. The caller answers the wait. */
  onTaskDrop?: ((requestId: string, card: BoardCard, columnKey: string) => void) | undefined;
};

/**
 * A phone's stand-in for `position: sticky` (the header above): what the scroller holding the board gives
 * its column headings — how far it is scrolled (an `Animated.Value` driven natively by its `onScroll`),
 * its content view to measure a heading against, and word when that content moved (`moved`, a set of
 * listeners the scroller calls on a content-size change). None on web, where sticky is sticky.
 */
export type StickyScrollValue = {
  y: Animated.Value;
  content: () => unknown;
  moved: Set<() => void>;
  /** The scroller itself, for a card held at its edge (`useEdgeScroll`). */
  edge: EdgeScroller;
};
export const StickyScroll = createContext<StickyScrollValue | null>(null);

/**
 * A column heading on a phone: its offset from the scroller's top is measured, and while the scroller is
 * past it, it is moved down by as much, but never past its column's foot (`room`: what is under the
 * heading in the column). Over the cards, which come after it.
 */
function StickyHead({ room, children }: { room: number; children: ReactNode }): JSX.Element {
  const sticky = useContext(StickyScroll);
  const ref = useRef<HostView>(null);
  const [top, setTop] = useState<number | null>(null);
  const measure = (): void => {
    const content = sticky?.content();
    if (ref.current === null || content === null || content === undefined) return;
    ref.current.measureLayout(content as never, (_x, y) => setTop((was) => (was === y ? was : y)), () => undefined);
  };
  useEffect(() => {
    if (sticky === null) return undefined;
    sticky.moved.add(measure);
    return () => void sticky.moved.delete(measure);
  });
  const shift =
    sticky === null || top === null || room <= 0
      ? 0
      : sticky.y.interpolate({ inputRange: [top, top + room], outputRange: [0, room], extrapolate: "clamp" });
  return (
    <Animated.View ref={ref} onLayout={measure} collapsable={false} style={{ zIndex: 1, transform: [{ translateY: shift }] }}>
      {children}
    </Animated.View>
  );
}

/** Where a menu was asked for, in the window's coordinates. */
export type MenuPoint = { x: number; y: number };

/**
 * The point of a right-click (web) or a long press (a phone), and the event claimed so the column under
 * a card does not open its own menu too.
 */
export function menuPointOf(e: unknown): MenuPoint {
  const ev = e as { preventDefault?: () => void; clientX?: number; clientY?: number; nativeEvent?: { pageX?: number; pageY?: number } };
  ev.preventDefault?.();
  if (ev.nativeEvent !== undefined && typeof ev.nativeEvent === "object") claimed.add(ev.nativeEvent);
  return typeof ev.clientX === "number" ? { x: ev.clientX, y: ev.clientY ?? 0 } : { x: ev.nativeEvent?.pageX ?? 0, y: ev.nativeEvent?.pageY ?? 0 };
}

/** A click's modifiers, where there are any (web); a tap has none. */
export type Mods = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

export interface BoardProps extends DragProps {
  board: BoardView;
  selected: string | null;
  selectedSet?: ReadonlySet<string> | undefined;
  numbered?: boolean;
  trays?: boolean;
  onSelectTask: (taskId: string, e?: Mods) => void;
  onSelectColumn?: ((stateId: string) => void) | undefined;
  selectedColumn?: string | null;
  onDrill: (stateId: string) => void;
  onOpenTask?: ((card: BoardCard) => void) | undefined;
  onOpenAt?: ((taskId: string, stateId: string | undefined) => void) | undefined;
  /** A card's right-click (a long press on a phone), at the point it happened. */
  onTaskMenu?: ((card: BoardCard, at: MenuPoint) => void) | undefined;
  /** A column's right-click where no card took it (a long press on a phone). */
  onColumnMenu?: ((stateId: string, at: MenuPoint) => void) | undefined;
  connect?:
    | {
        /** The dry run: what a drop of this card on that column would do (`connectDrag.ts`). */
        ask?: ConnectAsk;
        /** The commit — `confirmed` once the person said yes to the move table's question. */
        onDrop?: (card: BoardCard, column: BoardColumn, confirmed?: boolean) => void;
        onMove?: (card: BoardCard, move: NextMove, confirmed?: boolean) => void;
        undoable?: ReadonlySet<string>;
        onUndo?: (taskId: string) => void;
      }
    | undefined;
}

export function Board({
  board,
  selected,
  selectedSet,
  numbered = true,
  trays = true,
  onSelectTask,
  onSelectColumn,
  selectedColumn = null,
  onDrill,
  onOpenTask,
  onOpenAt,
  onTaskMenu,
  onColumnMenu,
  dragOffers = NO_DRAG_OFFERS,
  onTaskDrop,
  connect,
}: BoardProps): JSX.Element {
  const t = useTokens();
  const look = useLook();
  // Archived cards are held at the foot of each Finished lane; one Show here shows them in every column.
  const [showArchived, setShowArchived] = useState(false);
  const [confirming, setConfirming] = useState<MoveQuestion | null>(null);
  // The card in the air, and its connect answers (one dry run per column per drag): what they mean is
  // `boardDrag.ts`'s.
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const connecting = useRef<ConnectDrag | null>(null);
  const [, answered] = useReducer((n: number) => n + 1, 0);
  useEffect(() => () => connecting.current?.end(), []);
  const connectDrop: ConnectDrop | undefined = connect?.ask !== undefined && connect.onDrop !== undefined ? { ask: connect.ask, onDrop: connect.onDrop } : undefined;
  const pickUp = (card: BoardCard): void => {
    setDragging(card);
    connecting.current?.end();
    connecting.current = connectDragOf(board, card, dragOffers, connectDrop, answered);
  };
  const putDown = (): void => {
    connecting.current?.end();
    connecting.current = null;
    setDragging(null);
  };
  const dropFor = (column: BoardColumn): ColumnDrop | undefined =>
    columnDropOf({ card: dragging, column, dragOffers, drag: connecting.current, connect: connectDrop, onTaskDrop, putDown, confirm: setConfirming });
  // A phone's drag (`Lift`): the columns it may land in, the picture following the finger.
  const targets = useLiftTargets();
  const root = useRef<HostView>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const [ghost, setGhost] = useState<(Ghost & { card: BoardCard }) | null>(null);
  // Held at the scroller's edge, the card scrolls the board: the columns are measured again where they
  // now stand, and the picture stays under the finger.
  const edges = useEdgeScroll(useContext(StickyScroll)?.edge ?? null, (by) => {
    targets.measure();
    setGhost((g) => (g === null ? g : { ...ghostScrolled(g, by), card: g.card }));
  });
  const liftOf = (card: BoardCard, hold: ((x: number, y: number) => void) | undefined) => ({
    onLift: (node: HostView | null, x: number, y: number) => {
      pickUp(card);
      targets.measure();
      edges.begin();
      ghostOf(node, root.current, rootWidth, x, y, (g) => setGhost({ ...g, card }));
    },
    onMove: (x: number, y: number) => {
      targets.move(x, y);
      edges.at(y);
      setGhost((g) => (g === null ? g : { ...ghostAt(g, x, y), card: g.card }));
    },
    onLand: (x: number, y: number) => {
      const key = targets.hit(x, y);
      const column = board.columns.find((c) => c.key === key);
      const drop = column !== undefined ? dropFor(column) : undefined;
      targets.clear();
      edges.end();
      setGhost(null);
      // As a column's `drop` on web: only a column that would take it lands it; anywhere else it springs back.
      if (drop?.accepts === true) drop.onDrop();
      else putDown();
    },
    onCancel: () => {
      edges.end();
      if (connecting.current === null && dragging === null) return;
      targets.clear();
      setGhost(null);
      putDown();
    },
    ...(hold !== undefined ? { onHold: hold } : {}),
  });
  /** A chip's move: taken at once, or — where the table asks — once the person said yes. */
  const moveFrom = (card: BoardCard, columnKey: string) =>
    connect?.onMove === undefined
      ? undefined
      : (move: NextMove): void => {
          if (move.confirm !== undefined) {
            setConfirming({ column: columnKey, sentence: move.sentence ?? "Take this move?", yes: CONFIRM_YES[move.confirm], go: () => connect.onMove!(card, move, true) });
            return;
          }
          connect.onMove!(card, move);
        };
  const drillOf = (card: BoardCard): (() => void) | undefined => {
    if (onOpenTask !== undefined) return () => onOpenTask(card);
    const target = drillTargetOf(board, card);
    return target === undefined ? undefined : () => onDrill(target);
  };
  const isSelected = (card: BoardCard): boolean => (selectedSet !== undefined ? selectedSet.has(card.taskId) : card.taskId === selected);
  const roots = board.level === "";
  const cardOf = (card: BoardCard, last: boolean, column: BoardView["columns"][number] | null, tray = false): ReactNode => {
    const drill = drillOf(card);
    const move = column !== null ? moveFrom(card, column.key) : undefined;
    // Only a card in a column is lifted (the tray's are not), and only where a drop would mean something.
    const liftable = column !== null && canPickUp(card, dragOffers, onTaskDrop, connectDrop);
    const drawn = (
      <TaskCard
        key={card.taskId}
        card={card}
        last={last}
        inTray={tray}
        selected={isSelected(card)}
        onSelect={(e) => onSelectTask(card.taskId, modsOf(e))}
        {...(onTaskMenu !== undefined ? { onMenu: (e: unknown) => onTaskMenu(card, menuPointOf(e)) } : {})}
        onOrigin={(taskId, e, stateId) => (onOpenAt !== undefined ? onOpenAt(taskId, stateId) : onSelectTask(taskId, modsOf(e)))}
        {...(drill !== undefined ? { onDrill: drill } : {})}
        child={column !== null && card.under !== undefined && column.cards.some((other) => other.taskId === card.under)}
        {...(connect?.onUndo !== undefined && connect.undoable?.has(card.taskId) === true ? { onUndo: () => connect.onUndo!(card.taskId) } : {})}
        {...(move !== undefined ? { onMove: move } : {})}
        {...(liftable ? { onDragStart: () => pickUp(card), onDragEnd: putDown } : {})}
      />
    );
    if (isWeb || !liftable) return drawn;
    // Held still and let go, a lifted card was long-pressed: what its long press does (`TaskCard`).
    const hold = onTaskMenu !== undefined ? (x: number, y: number) => onTaskMenu(card, { x, y }) : drill;
    return (
      <Lift key={card.taskId} enabled {...liftOf(card, hold)}>
        {drawn}
      </Lift>
    );
  };
  const columns = board.columns.map((column, index) => (
    <Column
      key={column.key}
      t={t}
      look={look}
      index={index}
      name={column.label ?? column.key}
      {...(numbered ? { seq: index + 1 } : {})}
      count={column.cards.filter((card) => card.status !== "archived").length}
      empty="—"
      tip={onSelectColumn === undefined ? `double-click to open ${column.stateId}` : `click to describe ${column.stateId}, double-click to open it`}
      onOpen={() => onDrill(column.stateId)}
      {...(onSelectColumn !== undefined ? { onSelect: () => onSelectColumn(column.stateId) } : {})}
      {...(onColumnMenu !== undefined ? { onMenu: (at: MenuPoint) => onColumnMenu(column.stateId, at) } : {})}
      selected={column.stateId === selectedColumn}
      {...(dropFor(column) !== undefined ? { drop: dropFor(column)! } : {})}
      {...(!isWeb ? { over: targets.over === column.key, host: targets.host(column.key) } : {})}
      {...(confirming?.column === column.key
        ? {
            confirm: (
              <MoveConfirm
                sentence={confirming.sentence}
                yes={confirming.yes}
                onYes={() => {
                  const go = confirming.go;
                  setConfirming(null);
                  go();
                }}
                onNo={() => setConfirming(null)}
              />
            ),
          }
        : {})}
    >
      {(select, followed) => (
        <Lanes
          cards={column.cards}
          followed={followed}
          archived={{
            shown: showArchived,
            // The foot is a button inside the column, and claims its own click: it selects the column itself.
            onToggle: () => {
              setShowArchived((v) => !v);
              select?.();
            },
          }}
          render={(card, last) => cardOf(card, last, column)}
        />
      )}
    </Column>
  ));
  const atLevel = board.atLevel.filter((card) => card.status !== "archived");
  return (
    <View
      {...(!isWeb ? { ref: root, onLayout: (e: { nativeEvent: { layout: { width: number } } }) => setRootWidth(e.nativeEvent.layout.width) } : {})}
      flexDirection="column"
      gap={14}
      padding={10}
      {...((look.palette !== "blueprint" ? {} : isWeb ? graphPaperWeb(t) : { position: "relative" }) as object)}
    >
      {look.palette === "blueprint" && !isWeb ? <GraphPaper t={t} /> : null}
      {roots ? (
        <View flexDirection="row" flexWrap="wrap" alignItems="stretch" columnGap={10} rowGap={12}>
          {columns}
          {board.columns.length === 0 ? <NoChildren /> : null}
        </View>
      ) : isWeb ? (
        // A level below a root is a sequence and does not wrap. On web the row runs past the body, and the
        // column (`BoardColumn`, which scrolls both ways) scrolls sideways.
        <View flexDirection="row" alignItems="stretch" gap={10}>
          {columns}
          {board.columns.length === 0 ? <NoChildren /> : null}
        </View>
      ) : (
        // On a phone the board's own row scrolls sideways: a column scrolls one way at a time.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
          <View flexDirection="row" alignItems="stretch" gap={10} flexGrow={1}>
            {columns}
            {board.columns.length === 0 ? <NoChildren /> : null}
          </View>
        </ScrollView>
      )}
      {trays && atLevel.length > 0 ? (
        <View>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 700, upper: true, ls: 0.09, color: "dim" }} marginBottom={8}>
            At this level
          </Txt>
          <View flexDirection="row" flexWrap="wrap" gap={8}>
            <Lanes cards={atLevel} tray render={(card, last) => cardOf(card, last, null, true)} />
          </View>
        </View>
      ) : null}
      {ghost !== null ? <LiftedCard ghost={ghost} /> : null}
    </View>
  );
}

/**
 * A phone's picture of the card in the air, over the board where the finger is: the browser's drag image,
 * which is the card itself, see-through.
 */
function LiftedCard({ ghost }: { ghost: Ghost & { card: BoardCard } }): JSX.Element {
  return (
    <View position="absolute" left={ghost.left} top={ghost.top} width={ghost.width} opacity={0.8} pointerEvents="none" zIndex={10} transform={[{ translateX: ghost.dx }, { translateY: ghost.dy }] as never}>
      <TaskCard card={ghost.card} selected={false} onSelect={() => undefined} last />
    </View>
  );
}

function modsOf(e: unknown): Mods | undefined {
  const m = e as Partial<Mods> | undefined;
  return m !== undefined && typeof m === "object" && "shiftKey" in m ? { shiftKey: m.shiftKey === true, ctrlKey: m.ctrlKey === true, metaKey: m.metaKey === true } : undefined;
}

/** What a level with no child states says: the body's 13/12.5, --dim, padding 8 0 and a paragraph's 1em margins. */
function NoChildren(): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-app", 13 / 12.5);
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={size as number}>
      This state has no children.
    </Txt>
  );
}

/**
 * Blueprint's graph paper, the ground of the board's body: two 1px `--grid` gradients tiled at 16px
 * from the body's corner, the horizontal one over the vertical. On web, those gradients;
 * on a phone, which has no background images, the lines are views under everything else, laid when the
 * body's size is known.
 */
export function graphPaperWeb(t: Tokens): Record<string, unknown> {
  const grid = String(t.v("grid"));
  return {
    backgroundImage: `linear-gradient(${grid} 1px, transparent 1px), linear-gradient(90deg, ${grid} 1px, transparent 1px)`,
    backgroundSize: "16px 16px",
    backgroundAttachment: "local",
  };
}

export function GraphPaper({ t }: { t: Tokens }): JSX.Element {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const ink = t.v("grid") as never;
  return (
    <View
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      pointerEvents="none"
      overflow="hidden"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((was) => (was !== null && was.w === width && was.h === height ? was : { w: width, h: height }));
      }}
    >
      {size !== null ? (
        <>
          {Array.from({ length: Math.ceil(size.w / 16) }, (_, i) => (
            <View key={`v${i}`} position="absolute" top={0} bottom={0} left={i * 16} width={1} backgroundColor={ink} />
          ))}
          {Array.from({ length: Math.ceil(size.h / 16) }, (_, i) => (
            <View key={`h${i}`} position="absolute" left={0} right={0} top={i * 16} height={1} backgroundColor={ink} />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** `color-mix(in srgb, a <token>, b)` where the percentage is itself a token (`--lane-pct`). */
function mixBy(t: Tokens, a: string | number, pctToken: string, b: string | number): string {
  if (!t.replayed) return `color-mix(in srgb, ${String(a)} var(--${pctToken}), ${String(b)})`;
  return t.mix(a, parseFloat(String(t.v(pctToken))), b);
}

const CLEAR = "rgba(0, 0, 0, 0)";

/** How a column, its heading and its body are drawn in a look — the table above, decided. */
function columnStyle(t: Tokens, look: Look, index: number, selected: boolean, hovered: boolean, target = false, over = false) {
  const named = look.palette !== "classic";
  const line = look.buckets === "line";
  const pastel = look.palette === "pastel" || look.palette === "pastel-rail";
  const contrast = look.palette === "contrast";
  const blueprint = look.palette === "blueprint";
  const lane = look.lanes ? t.v(`lane-${(index % 6) + 1}`) : undefined;

  // --- the column ---
  let ground: string | number = named ? t.v("track") : t.v("panel-2");
  let border: string | number = named ? t.v("track-edge") : t.v("line");
  if (hovered) border = t.v("rule");
  if (selected) border = t.v("accent");
  let radius = contrast ? 0 : pastel ? 16 : blueprint ? 2 : 9;
  if (line) {
    ground = CLEAR;
    border = CLEAR;
    radius = 0;
  }
  let style: "dashed" | "solid" = blueprint ? "dashed" : "solid";
  let width = contrast ? 1.5 : 1;
  // A drop target: the accent, dashed, in every palette; a line bucket, with no edge, gets a 1px dashed
  // box of its own.
  if (target) {
    border = t.v("accent");
    style = "dashed";
    if (line) {
      width = 1;
      radius = 9;
    }
  }
  // Under the pointer: the fill the drop would land in — except where the column keeps its own ground (the header).
  if (over && !(line && (!named || selected || hovered))) ground = t.v("fill-ghost-selected");
  if (lane !== undefined) ground = line ? CLEAR : mixBy(t, lane, "lane-pct", t.v("bg"));

  // --- its heading ---
  let head: string | number = named ? t.v("track") : selected ? t.v("fill-ghost-selected") : t.v("panel-3");
  let ruleWidth = 1;
  let rule: string | number = named ? CLEAR : t.v("line");
  let headRadius = pastel ? 16 : 8;
  let below = 0;
  let padX = 10;
  let ink: string | number | undefined;
  if (look.palette === "hairline") {
    rule = t.v("line");
    below = 4;
  }
  if (contrast && !line && !look.lanes) {
    head = t.v("text");
    headRadius = 0;
    ink = t.v("bg");
  }
  if (blueprint) {
    head = t.v("bg");
    rule = t.v("rule");
    headRadius = 2;
  }
  if (line) {
    head = t.v("bg");
    ruleWidth = 2;
    rule = selected ? t.v("accent") : hovered ? t.v("rule") : t.v("line");
    headRadius = 0;
    padX = 3;
    below = 6;
  }
  let nameInk: string | number | undefined = ink;
  if (lane !== undefined) {
    head = line ? t.v("bg") : mixBy(t, lane, "lane-pct", t.v("bg"));
    rule = line ? lane : t.mix(lane, 35, t.v("line"));
    nameInk = mixBy(t, lane, "lane-ink", t.v("lane-deep"));
  }
  return {
    column: { ground, border, width, style, radius },
    head: { ground: head, rule, ruleWidth, radius: headRadius, below, padX, padTop: named ? 8 : 6, ink, nameInk, nameWeight: 700 },
    body: line ? { top: 0, x: 1, bottom: 6 } : named ? { top: 4, x: 7, bottom: 8 } : { top: 6, x: 6, bottom: 6 },
  };
}

/**
 * A board column: the track, its heading, and whatever was put in it. A click anywhere that is not a
 * card describes the column; a double-click (a long press on a phone) walks in.
 */
export function Column({
  t,
  look,
  index,
  name,
  seq,
  count,
  empty,
  tip,
  onOpen,
  onSelect,
  onMenu,
  selected = false,
  drop,
  over: overHere,
  host,
  confirm,
  children,
}: {
  t: Tokens;
  look: Look;
  index: number;
  name: ReactNode;
  seq?: number;
  count: number;
  empty: string;
  tip?: string;
  onOpen?: (() => void) | undefined;
  onSelect?: (() => void) | undefined;
  /** Its right-click (a long press on a phone), where no card took it. */
  onMenu?: ((at: MenuPoint) => void) | undefined;
  selected?: boolean;
  /** What a card being dragged right now would mean here (`boardDrag.ts`'s `ColumnDrop`); absent while nothing is. */
  drop?: ColumnDrop | undefined;
  /** A phone's: the lifted card is over this column (`Lift`). On web the column tracks `dragover` itself. */
  over?: boolean;
  /** A phone's: the column's view, measured when a card is lifted (`liftTargets.ts`). */
  host?: ((node: HostView | null) => void) | undefined;
  confirm?: ReactNode;
  /**
   * The cards, given the column's own click (for what inside it passes the click on) and whether
   * something follows them in the body — the "—", the preview, a move's question — so the last card is
   * not the body's last child (`TaskCard`'s `last`).
   */
  children: (select: (() => void) | undefined, followed: boolean) => ReactNode;
}): JSX.Element {
  const [hovered, hover] = useHover();
  // How far the heading may travel down its column on a phone (`StickyHead`): the body's height.
  const [bodyHeight, setBodyHeight] = useState(0);
  // Whether the pointer is over THIS column — a different fact from whether it would take the card.
  const [overWeb, setOver] = useState(false);
  const tracks = drop !== undefined && (drop.accepts || drop.preview !== undefined);
  const over = (isWeb ? overWeb : overHere === true) && tracks;
  const accepts = drop?.accepts === true;
  const s = columnStyle(t, look, index, selected, hovered, accepts, accepts && over);
  const box = {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 210,
    maxWidth: 320,
    minWidth: 0,
    flexDirection: "column",
    backgroundColor: s.column.ground,
    borderWidth: s.column.width,
    borderStyle: s.column.style,
    borderColor: s.column.border,
    borderRadius: s.column.radius,
  } as const;
  const head = (
    <View
      // Sticky on web: the heading stays put while a long column scrolls under it (and how Chromium
      // composites a sticky box decides how its text is smoothed). On a phone `StickyHead` moves it
      // instead.
      {...((isWeb ? { position: "sticky", top: 0, zIndex: 1 } : {}) as object)}
      flexDirection="row"
      alignItems="baseline"
      gap={7}
      paddingTop={s.head.padTop}
      paddingBottom={6}
      paddingLeft={s.head.padX}
      paddingRight={s.head.padX}
      marginBottom={s.head.below}
      backgroundColor={s.head.ground as never}
      borderTopLeftRadius={s.head.radius}
      borderTopRightRadius={s.head.radius}
      {...(edge(t, { bottom: s.head.ruleWidth }, String(s.head.rule)) as object)}
    >
      {seq !== undefined ? (
        <Txt
          register="data-num"
          flexShrink={0}
          {...((s.head.nameInk ?? s.head.ink) !== undefined ? { color: s.head.nameInk ?? s.head.ink } : {})}
          {...(s.head.nameInk !== undefined ? { fontWeight: "700" } : {})}
        >
          {seq}
        </Txt>
      ) : null}
      <Txt register="data-title" ellip flexShrink={1} minWidth={0} {...((s.head.nameInk ?? s.head.ink) !== undefined ? { color: s.head.nameInk ?? s.head.ink } : {})}>
        {name}
      </Txt>
      <Txt register="app-secondary" spec={{ tabular: true, ...(s.head.ink !== undefined ? { color: String(s.head.ink) } : {}) }} flexShrink={0} marginLeft="auto">
        {count}
      </Txt>
    </View>
  );
  const contents = (
    <>
      {isWeb ? head : <StickyHead room={bodyHeight}>{head}</StickyHead>}
      <View
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        minHeight={0}
        paddingTop={s.body.top}
        paddingLeft={s.body.x}
        paddingRight={s.body.x}
        paddingBottom={s.body.bottom}
        {...(isWeb ? {} : { onLayout: (e: { nativeEvent: { layout: { height: number } } }) => setBodyHeight(e.nativeEvent.layout.height) })}
      >
        {children(onSelect, count === 0 || (over && drop?.preview !== undefined) || confirm !== undefined)}
        {count === 0 ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingTop={2} paddingLeft={4} paddingRight={4} paddingBottom={6}>
            {empty}
          </Txt>
        ) : null}
        {over && drop?.preview !== undefined ? <ConnectPop preview={drop.preview()} /> : null}
        {confirm}
      </View>
    </>
  );
  if (isWeb) {
    // A click that a card (or its chips, or the foot) took is not the column's (`claimed`, by `TaskCard`).
    const web = {
      ...hover,
      ...(onSelect !== undefined ? { onClick: (e: ReactMouseEvent) => (claimed.has(e.nativeEvent) ? undefined : onSelect()) } : {}),
      ...(onOpen !== undefined ? { onDoubleClick: onOpen } : {}),
      ...(onMenu !== undefined ? { onContextMenu: (e: ReactMouseEvent) => (claimed.has(e.nativeEvent) ? undefined : onMenu(menuPointOf(e))) } : {}),
      ...(tip !== undefined ? { title: tip } : {}),
      // The drop handlers: `preventDefault` on drag-over IS the acceptance, and a column that would
      // refuse still tracks the pointer so it can say why. Leaving for a child is not leaving (the
      // preview is one).
      ...(tracks
        ? {
            onDragOver: (e: ReactDragEvent) => {
              if (accepts) e.preventDefault();
              if (!overWeb) setOver(true);
            },
            onDragLeave: (e: ReactDragEvent) => {
              if (!(e.currentTarget as Element).contains(e.relatedTarget as Node | null)) setOver(false);
            },
            onDrop: (e: ReactDragEvent) => {
              setOver(false);
              if (!accepts) return;
              e.preventDefault();
              drop.onDrop();
            },
          }
        : {}),
      cursor: "pointer",
    };
    return (
      <View {...(box as object)} {...(web as object)}>
        {contents}
      </View>
    );
  }
  // A phone: a tap anywhere not on a card describes the column, a long press opens its menu (or, with
  // none, walks in — the menu's Open).
  const long = onMenu !== undefined ? (e: unknown) => onMenu(menuPointOf(e)) : onOpen;
  return (
    <Pressable ref={host} {...(onSelect !== undefined ? { onPress: onSelect } : {})} {...(long !== undefined ? { onLongPress: long } : {})} style={box as never}>
      {contents}
    </Pressable>
  );
}

/**
 * A column's cards under a heading per lane (`laneRunsOf`: none where every card is in the same lane),
 * and the archived ones held at the foot behind one line saying how many.
 */
function Lanes({
  cards,
  render,
  archived,
  tray = false,
  followed = false,
}: {
  cards: readonly BoardCard[];
  render: (card: BoardCard, last: boolean) => ReactNode;
  archived?: { shown: boolean; onToggle: () => void } | undefined;
  /** In the "At this level" tray: each lane a full row of its own, wrapping. */
  tray?: boolean;
  /** Something follows the cards in the column's body (`Column`'s `followed`). */
  followed?: boolean;
}): JSX.Element {
  const t = useTokens();
  const { live, held } = archivedSplitOf(cards);
  const { boxed, runs } = laneRunsOf(live, held.length > 0 || followed);
  const inOrder = (entries: readonly LaneEntry[]): ReactNode[] =>
    entries.map(({ card, last, beneath }) => (
      <Fragment key={card.taskId}>
        {render(card, last)}
        {beneath.map((child) => render(child.card, child.last))}
      </Fragment>
    ));
  return (
    <>
      {!boxed
        ? inOrder(runs[0]?.entries ?? [])
        : runs.map(({ lane, headed, count, entries }) => (
            <Lane key={lane} dimmed={lane === "finished" || lane === "not-started"} tray={tray}>
              {headed ? (
                <View flexDirection="row" alignItems="center" gap={8} {...(tray ? { flexBasis: "100%", flexGrow: 1, flexShrink: 0 } : { marginTop: 10, marginBottom: 6 })}>
                  <Txt register="app-label" flexShrink={0}>
                    {LANE_LABEL[lane]}
                  </Txt>
                  <View flexGrow={1} flexShrink={1} flexBasis={0} height={1} backgroundColor={t.v("line") as never} />
                  <Txt register="data-num" spec={{ weight: 400 }} flexShrink={0}>
                    {count}
                  </Txt>
                </View>
              ) : null}
              {inOrder(entries)}
            </Lane>
          ))}
      {held.length > 0 ? (
        <>
          <ArchivedFoot count={held.length} archived={archived} />
          {archived?.shown === true ? held.map((card, i) => <Fragment key={card.taskId}>{render(card, i === held.length - 1 && !followed)}</Fragment>) : null}
        </>
      ) : null}
    </>
  );
}

/** A box per lane; finished and not-started ones at 0.72 until the pointer is on them. */
function Lane({ dimmed, tray, children }: { dimmed: boolean; tray: boolean; children: ReactNode }): JSX.Element {
  const [hovered, hover] = useHover();
  return (
    <View
      {...(hover as object)}
      flexDirection={tray ? "row" : "column"}
      {...(tray ? { flexWrap: "wrap", gap: 8, flexBasis: "100%", flexGrow: 1, flexShrink: 0 } : {})}
      {...(dimmed && !hovered ? { opacity: 0.72 } : {})}
    >
      {children}
    </View>
  );
}

/** "N archived", a rule, Show/Hide — the foot of a column that holds archived tasks. */
function ArchivedFoot({ count, archived }: { count: number; archived: { shown: boolean; onToggle: () => void } | undefined }): JSX.Element {
  const t = useTokens();
  const on = archived !== undefined;
  const word = (text: string, hovered: boolean): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: hovered ? "text" : "dim" }} flexShrink={0} {...(isWeb ? { whiteSpace: "nowrap" } : {})}>
      {text}
    </Txt>
  );
  return (
    <Press
      {...(on ? { onPress: (e: { nativeEvent?: object }) => (e.nativeEvent !== undefined && claimed.add(e.nativeEvent), archived.onToggle()) } : {})}
      disabled={!on}
      title={archived?.shown === true ? "Hide the archived tasks" : "Show the archived tasks, kept with their history"}
      marginTop={2}
      flexDirection="row"
      alignItems="center"
      justifyContent="flex-start"
      gap={8}
      paddingTop={4}
      paddingBottom={4}
      paddingLeft={2}
      paddingRight={2}
      borderRadius={t.v("control-radius")}
      {...(!on ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && on ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {word(`${count} archived`, hovered && on)}
          <View flexGrow={1} flexShrink={1} flexBasis={0} height={1} backgroundColor={t.v("line") as never} />
          {on ? word(archived.shown ? "Hide" : "Show", hovered) : null}
        </>
      )}
    </Press>
  );
}

/**
 * The move table's question (decision 0005): a drop — or a chip — whose move stops or pauses a working
 * task asks first, in the column the task would land in, under its cards. The drop preview's box with a
 * warning edge: --panel, 1px --warn at 55% over --line, radius 10, padding 12, gap 8, --lift, 8 above; the
 * kind (`ConnectPop`'s `Kind`: data 600 at `--size-app` × 10.5/12.5), the sentence (1.45), and a primary
 * and a ghost button at the box's `--size-app`, gap 6, 14 above.
 */
function MoveConfirm({ sentence, yes, onYes, onNo }: { sentence: string; yes: string; onYes: () => void; onNo: () => void }): JSX.Element {
  const t = useTokens();
  const stop = isWeb
    ? {
        onClick: (e: ReactMouseEvent) => {
          claimed.add(e.nativeEvent);
        },
        onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
      }
    : {};
  return (
    <View
      {...(stop as object)}
      marginTop={8}
      padding={12}
      gap={8}
      backgroundColor={t.v("panel") as never}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("warn"), 55, t.v("line")) as never}
      borderRadius={10}
      {...((isWeb ? { boxShadow: t.v("lift"), role: "alertdialog", "aria-label": "Confirm the move" } : {}) as object)}
    >
      <Kind t={t}>Confirm the move</Kind>
      <Txt spec={{ voice: "app", scale: 1, lineHeight: 1.45 }}>{sentence}</Txt>
      {/* The answers: 14 above, on top of the box's gap; the buttons in the box's own size. */}
      <View flexDirection="row" flexWrap="wrap" gap={6} marginTop={14}>
        <Button kind="primary" font={{ scale: 1 }} onPress={onYes}>
          {yes}
        </Button>
        <Button kind="ghost" font={{ scale: 1 }} onPress={onNo}>
          Cancel
        </Button>
      </View>
    </View>
  );
}
