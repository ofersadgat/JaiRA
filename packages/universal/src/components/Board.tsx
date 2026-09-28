import { Fragment, useState, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Pressable, ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { BoardCard, BoardView, MoveConfirm as MoveConfirmKind, NextMove } from "@jaira/shared/browser";
import { archivedSplitOf, drillTargetOf, LANE_LABEL, laneRunsOf, type LaneEntry } from "@jaira/ui/boardModel";
import { Press, Txt, edge, useHover } from "../primitives";
import { useLook, useTokens, type Look, type Tokens } from "../tokens";
import { claimed, TaskCard } from "./TaskCard";

/**
 * `board.tsx`'s `Board`, universal (decision 0015): child states as columns, the tasks in them as cards
 * (`TaskCard`), split into lanes, archived ones held at each column's foot. Read that one for what the
 * board means; this one only has to look and act the same. The rules it carries, from `styles.css`,
 * with the contests `cascade.mts` settled:
 *
 *   .board-body                  column, gap 14, padding 10 (overflow visible while every project is listed)
 *   .columns / .columns.wrap     row, gap 10, stretch; the root listing wraps with a 12 row gap
 *   .column                      flex 1 0 210, at most 320; --panel-2, 1px --line, radius 9; hover --rule,
 *                                selected --accent
 *   .column h4                   row, baseline, gap 7, padding 6 10, --panel-3, 1px --line under, radius 8 8 0 0
 *   .column.sel > h4             --fill-ghost-selected (0,2,1: every palette's h4 rule beats it)
 *   .column-body                 column, flex 1, padding 6; `.empty` "—" --dim, padding 2 4 6
 *   .col-name / .count / .seq    data-title, ellipsised / app-secondary, tabular, pushed right / data-num
 *   :root[data-palette] …        the track: --track ground, --track-edge; the h4 on --track with no rule
 *                                under it and 8 above; the body 4 7 8
 *   [data-palette="hairline"]    the h4 keeps a --line rule, 4 below
 *   [data-palette="contrast"]    square, 1.5 edge; unless line buckets or lanes, the h4 an inverted band
 *   pastel, pastel-rail          radius 16, the h4 16 16 0 0
 *   [data-palette="blueprint"]   dashed, radius 2; the h4 on --bg over a 1px --rule, 2 2 0 0; the body
 *                                on 16px graph paper (--grid)
 *   [data-buckets="line"]        no box (transparent, square, hover and selected alike); the h4 on --bg
 *                                over a 2px --line (--rule hovered, --accent selected), 3 either side, 6
 *                                below; the body 0 1 6
 *   [data-lanes]                 each column its lane colour (nth-child 6n+k): the ground and the h4 at
 *                                --lane-pct over --bg, the h4's rule 35% over --line, the name and seq in
 *                                --lane-ink over --lane-deep, 700; with line buckets, the ground clear and
 *                                the rule the lane's own
 *   .lane / .lane h5             a box per lane; the heading a row, centred, gap 8, 10 above 6 below: the
 *                                label (app-label), a 1px --line rule taking the slack, the count (data-num
 *                                at 400, `.count` wins); finished and not-started lanes 0.72, 1 hovered
 *   .lane-archived               the foot: a row, gap 8, 2 above, padding 4 2, --dim at 11.5/12.5,
 *                                "N archived", a --line rule, Show/Hide; hovered --fill-ghost-hover, --text
 *   .tray / .tray-cards          "At this level": an uppercase h4 (11/12.5, bold, .09em, 8 below) over
 *                                cards 210 wide, wrapped with a gap of 8, lanes a row each
 *
 * Not copied: the sticky column heading on a phone (React Native has none; there a column's heading
 * scrolls with it — on web it sticks, as the desktop's does), the drop preview and dragging (v2, the props are kept).
 *
 * The right-click menus: a card's (`onTaskMenu`) and a column's (`onColumnMenu`), at the pointer, the
 * column's only where no card took the click (the DOM's `closest(".card")` guard, read off `claimed`). On
 * a phone the gesture is a long press, and the menu's Open is what a long press did before.
 */

/** The sets of events a drop needs — kept so the props match the DOM board's; dragging is v2. */
export type DragProps = {
  dragOffers?: unknown;
  onTaskDrop?: ((requestId: string, card: BoardCard, columnKey: string) => void) | undefined;
};

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
        ask?: unknown;
        onDrop?: unknown;
        onMove?: (card: BoardCard, move: NextMove, confirmed?: boolean) => void;
        undoable?: ReadonlySet<string>;
        onUndo?: (taskId: string) => void;
      }
    | undefined;
}

/** The yes of each ASK cell, as its button says it (`board.tsx`). */
const CONFIRM_YES: Record<MoveConfirmKind, string> = { "stop-and-rewind": "Stop and go back", "pause-and-move": "Pause and move" };

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
  connect,
}: BoardProps): JSX.Element {
  const t = useTokens();
  const look = useLook();
  // Archived cards are held at the foot of each Finished lane; one Show here shows them in every column.
  const [showArchived, setShowArchived] = useState(false);
  const [confirming, setConfirming] = useState<{ column: string; sentence: string; yes: string; go: () => void } | null>(null);
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
    return (
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
      />
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
      {(select) => (
        <Lanes
          cards={column.cards}
          archived={{
            shown: showArchived,
            // The foot is a button inside the column, and in the DOM its click goes on to the column.
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
        // A level below a root is a sequence and does not wrap. On web the row runs past the body, as the
        // desktop's does, and the column (`BoardColumn`, which scrolls both ways) scrolls sideways.
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
    </View>
  );
}

function modsOf(e: unknown): Mods | undefined {
  const m = e as Partial<Mods> | undefined;
  return m !== undefined && typeof m === "object" && "shiftKey" in m ? { shiftKey: m.shiftKey === true, ctrlKey: m.ctrlKey === true, metaKey: m.metaKey === true } : undefined;
}

/** `<p class="empty">` in `.columns`: the body's 13/12.5, --dim, padding 8 0 and the paragraph's 1em margins. */
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
 * Blueprint's graph paper (`:root[data-palette="blueprint"] .board-body`): two 1px `--grid` gradients
 * tiled at 16px from the body's corner, the horizontal one over the vertical. On web, those gradients;
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

/** How a column, its heading and its body are drawn in a look — the cascade above, decided. */
function columnStyle(t: Tokens, look: Look, index: number, selected: boolean, hovered: boolean) {
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
    column: { ground, border, width: contrast ? 1.5 : 1, style: (blueprint ? "dashed" : "solid") as "dashed" | "solid", radius },
    head: { ground: head, rule, ruleWidth, radius: headRadius, below, padX, padTop: named ? 8 : 6, ink, nameInk, nameWeight: 700 },
    body: line ? { top: 0, x: 1, bottom: 6 } : named ? { top: 4, x: 7, bottom: 8 } : { top: 6, x: 6, bottom: 6 },
  };
}

/**
 * A board column (`board.tsx`'s `Column`): the track, its heading, and whatever was put in it. A click
 * anywhere that is not a card describes the column; a double-click (a long press on a phone) walks in.
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
  confirm?: ReactNode;
  children: (select: (() => void) | undefined) => ReactNode;
}): JSX.Element {
  const [hovered, hover] = useHover();
  const s = columnStyle(t, look, index, selected, hovered);
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
  const contents = (
    <>
      <View
        // Sticky on web, as the desktop's: the heading stays put while a long column scrolls under it
        // (and Chromium composites it as it does the desktop's, which decides how its text is smoothed).
        // A phone has no sticky, and its heading scrolls with the column.
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
      <View flexGrow={1} flexShrink={1} flexDirection="column" minHeight={0} paddingTop={s.body.top} paddingLeft={s.body.x} paddingRight={s.body.x} paddingBottom={s.body.bottom}>
        {children(onSelect)}
        {count === 0 ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingTop={2} paddingLeft={4} paddingRight={4} paddingBottom={6}>
            {empty}
          </Txt>
        ) : null}
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
    <Pressable {...(onSelect !== undefined ? { onPress: onSelect } : {})} {...(long !== undefined ? { onLongPress: long } : {})} style={box as never}>
      {contents}
    </Pressable>
  );
}

/**
 * `board.tsx`'s `Lanes`: a column's cards under a heading per lane (`laneRunsOf`), and the archived ones
 * held at the foot behind one line saying how many.
 */
function Lanes({
  cards,
  render,
  archived,
  tray = false,
}: {
  cards: readonly BoardCard[];
  render: (card: BoardCard, last: boolean) => ReactNode;
  archived?: { shown: boolean; onToggle: () => void } | undefined;
  /** In the "At this level" tray: each lane a full row of its own, wrapping (`.tray-cards .lane`). */
  tray?: boolean;
}): JSX.Element {
  const t = useTokens();
  const { live, held } = archivedSplitOf(cards);
  const { boxed, runs } = laneRunsOf(live, held.length > 0);
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
          {archived?.shown === true ? held.map((card, i) => <Fragment key={card.taskId}>{render(card, i === held.length - 1)}</Fragment>) : null}
        </>
      ) : null}
    </>
  );
}

/** `.lane`: a box per lane; finished and not-started ones at 0.72 until the pointer is on them. */
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

/** `.lane-archived`: "N archived", a rule, Show/Hide — the foot of a column that holds archived tasks. */
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
 * `board.tsx`'s `MoveConfirm`: the move table's question, in the column the task would land in, under its
 * cards. `.connect-pop.connect-pop-inline.connect-confirm`: --panel, 1px --warn at 55% over --line, radius
 * 10, padding 12, gap 8, --lift, 8 above; the kind (data 600 at 10.5/12.5, 1.3, .04em, upper, --dim), the
 * sentence (1.45), and a primary and a ghost button, gap 6.
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
  const button = (label: string, primary: boolean, onPress: () => void): JSX.Element => (
    <Press
      onPress={onPress}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      borderWidth={1}
      borderStyle="solid"
      borderRadius={t.v("control-radius")}
      paddingVertical={4}
      paddingHorizontal={10}
      box={({ hovered }) =>
        primary
          ? { backgroundColor: hovered ? t.v("fill-accent-hover") : t.v("fill-accent"), borderColor: hovered ? t.v("fill-accent-hover") : t.v("fill-accent") }
          : { backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent", borderColor: hovered ? t.v("rule") : t.v("line") }
      }
    >
      <Txt spec={{ voice: "app", scale: 1, weight: primary ? 600 : 400, color: primary ? "on-accent" : "text" }} textAlign="center">
        {label}
      </Txt>
    </Press>
  );
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
      <Txt spec={{ voice: "data", scale: 10.5 / 12.5, weight: 600, ls: 0.04, upper: true, color: "dim", lineHeight: 1.3 }}>Confirm the move</Txt>
      <Txt spec={{ voice: "app", scale: 1, lineHeight: 1.45 }}>{sentence}</Txt>
      <View flexDirection="row" flexWrap="wrap" gap={6}>
        {button(yes, true, onYes)}
        {button("Cancel", false, onNo)}
      </View>
    </View>
  );
}
