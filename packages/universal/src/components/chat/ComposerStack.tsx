import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView, TextInput, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { PermissionSetTree, PermissionSetTreeRequest, PermissionSetTreeSet, ToolChoice, WritableSetLayer } from "@jaira/shared/browser";
import { permissionSetIdAt } from "@jaira/shared/browser";
import {
  UNFOLDED_HEIGHT,
  collapsedWordsOf,
  contentsNoteOf,
  crumbsOf,
  childrenOf,
  ownSetOf,
  panelColumnsOf,
  panelRowsOf,
  referenceOfPick,
  runtimeMarkOf,
  segmentTitleOf,
  segmentWordsOf,
  setAtOf,
  setListOf,
  setListRowsOf,
  setListStepOf,
  stackRowsOf,
  treeAtOf,
  treeRowsOf,
  type CollapsedStack,
  type Crumb,
  type CrumbChoice,
  type LayerSegment,
  type PanelRow,
  type PanelView,
  type SetListGroup,
  type SetListRow,
  type StackPick,
  type StackSegment,
  type TreeAt,
  type TreeRow,
} from "@jaira/ui/composerStack";
import { placeFloat, type FloatRect } from "@jaira/ui/floatPlace";
import { KEEP_WHERE } from "@jaira/ui/composerCards";
import { setIconGlyph } from "@jaira/ui/permissionSetWords";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { useView } from "@jaira/ui/useView";
import { NO_STACK, Press, Txt, edge, font, placeholderColor } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { useShellOrNull, type AppModel } from "../../app/shell";
import { usePhone } from "../../app/phone";
import { useCanHover } from "../../canHover";
import { MenuLayer } from "../MenuLayer";
import { useKeyboardInset } from "../floats/keyboard";
import { SchemaForm } from "../form/SchemaForm";
import { Icon, type IconName } from "../panel/Icon";
import { PermissionSetCard } from "../settings/permissions/PermissionSetCard";
import { SubMenu, useAnchorRect } from "./ComposerCards";
import { arriveMotion, columnMotion, morphMotion, turnMotion } from "./stackMotion";
import { PermissionBoard } from "./PermissionBoard";
import type { PermissionBoardHost } from "@jaira/ui/permissionBoardHost";

/**
 * The composer's permission STACK (decision 0023 §4.1, design 6 of round 8): the Permissions chip as one
 * joined segment per layer, oldest to newest, and the PANEL each part of it opens (2026-11-14, round 3
 * of the mockups). What it says and every edit are `composerStack.ts`'s; what it reads and writes,
 * `composerStackHost.ts`'s. Render functions: the caller places the bar and opens the panel.
 *
 *   the bar          row, the segments 1 apart; a segment padding 3 9, app 11.5/12.5, --panel-2, --dim
 *                    (hovered --panel-3 and --text; open --accent 13% and --accent); the first rounded on
 *                    its left, the last on its right; the shield cap first, its icon 13 --tok-hint; the
 *                    bottom layer's icon 12 and its ⌄; the tools segment's run answers `· 3` in --accent
 *   collapsed        one segment, round both ends: the shield 13, the bottom layer's icon 12, `+n`
 *
 * The panel — ONE float, above the segment pressed, 7 apart; 1px --line, radius 12, --panel, --lift.
 * It never swaps one view for another: it widens, narrows, grows and slides (`stackMotion.web.ts`).
 *
 *   a layer          the sets it can be swapped for, 300 wide: a label (`Swap ask-first for`), a find
 *                    box, the sets in groups — its own group first, `Beside it` — and the layer's
 *                    actions under them. A pinned layer cannot be swapped: its list opens unfolded on
 *                    its own contents, its rows only to look at.
 *   +                the same list, `Lay on top`.
 *   ⋯ n              a row per layer, newest on top, 400 wide: its name (pressed: the list, to swap it),
 *                    `folded` where the bar folds it, later ↑, earlier ↓, pin, ×; `Lay a set on top…`
 *                    and `Whole picture ⤢` under them. The stack collapsed opens this too.
 *   the shield       the whole picture, 900 wide: this stack's layers and tools above the scopes' tree,
 *                    beside what the one picked writes.
 *   a row's ›        unfolds that set's contents out to the RIGHT, 500 wide, the list staying where it
 *                    is; the › turns into ‹ while they are out. A phone has no room beside: its contents
 *                    come over the list, `‹` to go back.
 *
 *   a list row       row, centred, gap 9, padding 5 8, radius 7, 4 in; icon 14 --dim (the layer's own:
 *                    --accent, its row --accent 13%, a ✓); the id data 500 12, `in the stack` beside it;
 *                    what it is for app 10.5 --tok-hint (a file that cannot be read: why, --warn); the ›
 *                    22 square, shown under the pointer, on the layer's own row, on the row unfolded
 *                    and on the row the keys are on — always, where nothing hovers
 *   a group label    app 600 9.5 upper, --tok-hint, padding 8 12 3
 *   the find box     row, gap 7, margin 6 8 4, padding 5 9, 1px --line, radius 8, --bg; app 12.5
 *   the actions      row, wraps, gap 12, padding 7 9 8, a --panel-2 rule above, app 10.5 --accent;
 *                    `remove` --bad, pushed right
 *   the contents     a head (padding 8 9, a --panel-2 rule under it: the file glyph, the crumbs, ⤡),
 *                    the set's card, read-only, scrolling; a foot with what may be done with THIS set
 */

/** The bar drawn (not the ruler's copy), marked for the panel: a press on one of its segments goes through the panel's layer to it. */
const STACK_BAR_MARK: Record<string, unknown> = isWeb ? { "data-stackbar": "" } : {};
const STACK_SEGMENT = "[data-stackbar] [aria-expanded]";

/** One row of the bar's look, measured in the composer's ruler. */
export function StackBar({
  segments,
  collapsed,
  open,
  onOpen,
  onLead,
}: {
  segments: readonly StackSegment[];
  /** Drawn collapsed — the shield, the bottom layer's icon and `+n` — when the composer is too narrow for the segments. */
  collapsed?: CollapsedStack | undefined;
  /** The segment open, by key. */
  open: string | undefined;
  onOpen: (segment: StackSegment, at: FloatRect) => void;
  /** The shield cap: the whole stack. Absent ⇒ the ruler's copy: drawn to be measured, named nothing and pressed by nobody. */
  onLead?: ((at: FloatRect) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const ruler = onLead === undefined;
  if (collapsed !== undefined) {
    const more = collapsedWordsOf(collapsed);
    const lit = open !== undefined;
    return (
      <View flexDirection="row" alignItems="center" flexShrink={0} {...(ruler ? {} : STACK_BAR_MARK)}>
        <Segment t={t} first last on={lit} title={ruler ? undefined : collapsed.title} label={ruler ? undefined : "Permissions"} onPress={onLead}>
          {(hovered) => (
            <>
              <Icon name="shield" size={13} color={String(t.v(lit ? "accent" : "tok-hint"))} />
              {collapsed.icon !== undefined ? <Icon name={setIconGlyph(collapsed.icon)} size={12} color={String(t.v(lit ? "accent" : "tok-hint"))} /> : null}
              {more !== null ? (
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: lit ? "accent" : hovered ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
                  {more}
                </Txt>
              ) : null}
            </>
          )}
        </Segment>
      </View>
    );
  }
  return (
    <View flexDirection="row" alignItems="center" flexShrink={0} {...(ruler ? {} : ({ role: "group", "aria-label": "Permissions", ...STACK_BAR_MARK } as object))}>
      <Segment t={t} first last={false} on={open === "lead"} title={ruler ? undefined : "Permissions: everything the stack comes to"} label={ruler ? undefined : "Permissions"} onPress={onLead}>
        {() => <Icon name="shield" size={13} color={String(t.v(open === "lead" ? "accent" : "tok-hint"))} />}
      </Segment>
      {segments.map((segment, i) => {
        const words = segmentWordsOf(segment);
        const mark = runtimeMarkOf(segment);
        const on = open === segment.key;
        const bottom = segment.kind === "layer" && segment.role === "bottom";
        // A layer the engine could not read: said in --warn, with the reason in its tooltip.
        const broken = segment.kind === "layer" && segment.problem !== undefined;
        return (
          <Segment key={segment.key} t={t} first={false} last={i === segments.length - 1} on={on} title={ruler ? undefined : segmentTitleOf(segment)} label={ruler ? undefined : segment.kind === "layer" ? segment.id : segment.kind} onPress={ruler ? undefined : (at) => onOpen(segment, at)}>
            {(lit) => (
              <>
                {broken ? <Icon name="alert" size={12} color={String(t.v("warn"))} /> : bottom ? <Icon name={setIconGlyph(segment.icon)} size={12} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
                {segment.kind === "tools" ? <Icon name="tool" size={12} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: broken ? "warn" : on ? "accent" : lit ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
                  {words}
                </Txt>
                {/* The run's answers, in --accent: what this run changed, marked on the lines in the card. */}
                {mark !== null ? (
                  <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600, color: "accent" }} numberOfLines={1} flexShrink={0} marginLeft={-2}>
                    {mark}
                  </Txt>
                ) : null}
                {bottom ? <Icon name="chevron" size={10} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
              </>
            )}
          </Segment>
        );
      })}
    </View>
  );
}

/** One joined segment: measured in the window when pressed, for its card to open against. */
function Segment({ t, first, last, on, title, label, onPress, children }: { t: Tokens; first: boolean; last: boolean; on: boolean; title: string | undefined; label: string | undefined; onPress?: ((at: FloatRect) => void) | undefined; children: (lit: boolean) => ReactNode }): JSX.Element {
  const [ref, measure] = useAnchorRect();
  const radius = { borderTopLeftRadius: first ? 999 : 0, borderBottomLeftRadius: first ? 999 : 0, borderTopRightRadius: last ? 999 : 0, borderBottomRightRadius: last ? 999 : 0 };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, marginLeft: first ? 0 : 1, ...NO_STACK } as never}>
      <Press
        onPress={() => (onPress !== undefined ? measure(onPress) : undefined)}
        {...(title !== undefined ? { title } : {})}
        {...(label !== undefined ? { label } : {})}
        {...({ "aria-expanded": on } as object)}
        {...(onPress === undefined ? { focusable: false } : {})}
        flexDirection="row"
        alignItems="center"
        gap={5}
        paddingVertical={3}
        paddingHorizontal={9}
        // The chips' 1px edge, transparent, so a segment stands as tall as a chip.
        borderWidth={1}
        borderStyle="solid"
        borderColor="transparent"
        {...radius}
        box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.v("panel-3") : t.v("panel-2") })}
      >
        {({ hovered }) => children(hovered || on)}
      </Press>
    </RNView>
  );
}

// --- the panel ------------------------------------------------------------------------------------

/**
 * The float every view of the panel is drawn in: placed above its anchor by `floatPlace.ts`, at the
 * width it is handed and the height its contents come to, and — on web — easing from each to the next
 * (`morphMotion`), so a view becoming another is the same box changing shape. Its height is measured
 * off what is in it; until it is known the box is drawn where it will not be seen.
 */
function MorphFloat({ anchor, width, onClose, children }: { anchor: FloatRect; width: number; onClose: () => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const whole = useWindowDimensions();
  const covered = useKeyboardInset();
  const win = covered > 0 ? { width: whole.width, height: whole.height - covered } : whole;
  const [natural, setNatural] = useState<number | null>(null);
  // Drawn once where it lands before anything eases: nothing comes in from where it never was.
  const [settled, setSettled] = useState(false);
  const height = natural === null ? null : natural + 2;
  const placed = height === null ? null : placeFloat(anchor, { width, height }, win, "above", "start", 7);
  const shown = placed !== null;
  useEffect(() => {
    if (!shown || settled) return;
    const timer = setTimeout(() => setSettled(true), 200);
    return () => clearTimeout(timer);
  }, [shown, settled]);
  return (
    // A press on another segment of the bar goes through to it: the same float is carried there.
    <MenuLayer onClose={onClose} through={STACK_SEGMENT}>
      <View
        position="absolute"
        left={placed?.left ?? 0}
        top={placed?.top ?? 0}
        width={width}
        {...(height !== null ? { height: placed?.maxHeight ?? height } : {})}
        {...(placed === null ? { opacity: 0, pointerEvents: "none" } : {})}
        {...((placed?.maxHeight !== undefined ? (isWeb ? { overflowY: "auto" } : {}) : {}) as object)}
        overflow={placed?.maxHeight !== undefined && isWeb ? undefined : "hidden"}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")) } as object)}
        {...(placed !== null ? morphMotion(settled ? "on" : "opening") : {})}
      >
        <View flexShrink={0} onLayout={(e: { nativeEvent: { layout: { height: number } } }) => setNatural((was) => (was !== null && Math.abs(was - e.nativeEvent.layout.height) < 0.5 ? was : e.nativeEvent.layout.height))}>
          {children}
        </View>
      </View>
    </MenuLayer>
  );
}

/** What opened the panel: a layer's segment, `+`, `⋯ n` (or the stack collapsed), or the shield. */
export type StackDoor = { kind: "layer"; layer: LayerSegment } | { kind: "add" } | { kind: "rows" } | { kind: "whole" } | { kind: "board"; order: "shield" | "tools" };

/** A layer as the panel keeps hold of it: by what it names, so it is found again as the stack moves. */
interface LayerHold {
  reference: string | undefined;
  role: LayerSegment["role"];
  id: string;
}

const holdOf = (layer: LayerSegment): LayerHold => ({ reference: layer.reference, role: layer.role, id: layer.id });
const liveOf = (layers: readonly LayerSegment[], hold: LayerHold): LayerSegment | undefined =>
  layers.find((layer) => layer.reference === hold.reference && layer.role === hold.role) ?? layers.find((layer) => layer.id === hold.id && layer.role === hold.role);
/** A rows panel's row, by what it names — its key moves with its place. */
const rowKeyOf = (layer: LayerSegment): string => `${layer.role}:${layer.reference ?? layer.id}`;
/** What `shown` is for a list unfolded on the layer's OWN set before its row is known. */
const SELF = "self";

/** Where the panel is. */
interface PanelNav {
  /** The door it was opened by: another door pressed starts again. */
  door: string;
  view: PanelView;
  /** The board's order (decision 0034): built up from the root set (the shield), or from the Result (the Tools card). */
  order?: "shield" | "tools";
  /** The layer a list swaps. Absent: `+`'s list. */
  layer?: LayerHold;
  /** Reached from the rows: `‹` goes back to them. */
  fromRows: boolean;
  /** What is unfolded: a list row's key, {@link SELF}, or a rows panel's row ({@link rowKeyOf}). */
  shown?: string;
  /** The list row the keys are on. */
  picked?: string;
  query: string;
}

function navOf(door: StackDoor, key: string, actionsOf: (layer: LayerSegment) => LayerActions): PanelNav {
  switch (door.kind) {
    case "layer":
      // A layer that cannot be swapped opens on what it writes: that is what there is to see.
      return { door: key, view: "list", layer: holdOf(door.layer), fromRows: false, ...(actionsOf(door.layer).onSwap === undefined ? { shown: SELF } : {}), query: "" };
    case "add":
      return { door: key, view: "list", fromRows: false, query: "" };
    case "rows":
      return { door: key, view: "rows", fromRows: false, query: "" };
    case "whole":
      // The shield opens the board, built up from the root set; its "Layers and sets…" is the picture.
      return { door: key, view: "board", order: "shield", fromRows: false, query: "" };
    case "board":
      return { door: key, view: "board", order: door.order, fromRows: false, query: "" };
  }
}

/** The set unfolded beside the list: what it is named by, and its file. */
interface Shown {
  key: string;
  id: string;
  icon: string;
  reference: string | undefined;
  set: PermissionSetTreeSet | undefined;
  /** It is the layer's own set. */
  own: boolean;
  /** The rows panel's layer it is, there. */
  layer?: LayerSegment;
}

const setOfLayer = (tree: PermissionSetTree | undefined, layer: LayerSegment): PermissionSetTreeSet | undefined => (tree !== undefined ? setAtOf(tree, treeAtOf(tree, layer.reference, layer.id)) : undefined);

/**
 * The stack's panel (2026-11-14): what a layer, `+`, `⋯ n` and the shield open, in one float that
 * morphs between them. `door` says which was pressed and `doorKey` which segment, so pressing another
 * while it is open carries the float there.
 */
export function StackPanel({
  anchor,
  door,
  doorKey,
  host,
  layers,
  bar,
  actionsOf,
  onAdd,
  tools,
  runtime,
  toolsBody,
  board,
  onToolList,
  onClose,
}: {
  anchor: FloatRect;
  door: StackDoor;
  doorKey: string;
  host: StackCardHost;
  /** The stack's layers, oldest first, as they stand now. */
  layers: readonly LayerSegment[];
  /** The bar as it is drawn — which layers it folds away. */
  bar: readonly StackSegment[];
  actionsOf: (layer: LayerSegment) => LayerActions;
  onAdd: (reference: string) => void;
  /** The tools offered, and the answers this run gave — what the whole picture's `tools` row says. */
  tools: number;
  runtime: number;
  /** The Tools card's body, drawn when the whole picture's `tools` is picked. */
  toolsBody: ReactNode;
  /** The permission board (decision 0034): what it draws and writes. */
  board: PermissionBoardHost;
  /** The Tools card's list, from the board's "Tool list…". */
  onToolList?: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const win = useWindowDimensions();
  const tree = useView("permissionSets:tree", host.treeRequest).value;
  const [kept, setNav] = useState<PanelNav>(() => navOf(door, doorKey, actionsOf));
  // Another door pressed while open: the same float, starting again from it.
  const nav = kept.door === doorKey ? kept : navOf(door, doorKey, actionsOf);
  if (nav !== kept) setNav(nav);
  const update = (patch: Partial<PanelNav>): void => setNav((was) => ({ ...(was.door === doorKey ? was : nav), ...patch }));

  const layer = nav.layer !== undefined ? liveOf(layers, nav.layer) : undefined;
  const actions = layer !== undefined ? actionsOf(layer) : undefined;
  const adding = nav.view === "list" && nav.layer === undefined;
  const still = nav.view === "list" && !adding && actions?.onSwap === undefined;
  const groups = useMemo(
    () => (tree !== undefined && nav.view === "list" ? setListOf(tree, layer !== undefined && !adding ? { reference: layer.reference, id: layer.id } : undefined, nav.query) : []),
    [tree, nav.view, adding, layer?.reference, layer?.id, nav.query],
  );
  const rows = setListRowsOf(groups);
  const panelRows = nav.view === "rows" ? panelRowsOf(layers, bar) : [];

  // What is unfolded beside the list, as a set to draw.
  const shown: Shown | undefined = (() => {
    if (nav.shown === undefined) return undefined;
    if (nav.view === "rows") {
      const row = panelRows.find((each) => rowKeyOf(each.layer) === nav.shown);
      return row !== undefined ? { key: nav.shown, id: row.layer.id, icon: row.layer.icon, reference: row.layer.reference, set: setOfLayer(tree, row.layer), own: true, layer: row.layer } : undefined;
    }
    if (nav.view !== "list") return undefined;
    const row = nav.shown === SELF ? rows.find((each) => each.current) : rows.find((each) => each.key === nav.shown);
    if (row !== undefined) return { key: row.key, id: row.id, icon: row.icon, reference: row.set.explicit ?? row.reference, set: row.set, own: row.current };
    if (nav.shown === SELF && layer !== undefined) return { key: SELF, id: layer.id, icon: layer.icon, reference: layer.reference, set: setOfLayer(tree, layer), own: true };
    return undefined;
  })();

  const unfolded = shown !== undefined;
  const room = Math.max(280, win.width - 32);
  const panelCols = panelColumnsOf(nav.view, unfolded, room, phone);
  // The board is as wide as it needs to be (it says), never wider than the window lets it.
  const [boardWidth, setBoardWidth] = useState<number | undefined>(undefined);
  const cols = nav.view === "board" && boardWidth !== undefined ? { ...panelCols, left: Math.min(boardWidth, room) } : panelCols;
  const unfoldedHeight = Math.max(UNFOLDED_HEIGHT.min, Math.min(UNFOLDED_HEIGHT.max, anchor.top - 7 - 16));
  // The rows a list shows before it scrolls: as many as the room over the bar leaves for them.
  const listHeight = Math.max(160, Math.min(380, anchor.top - 7 - 16 - 170));

  // Folding away, the contents stay drawn while their column narrows to nothing.
  const lastShown = useRef<Shown | undefined>(undefined);
  if (shown !== undefined) lastShown.current = shown;
  if (nav.view === "whole") lastShown.current = undefined;
  const drawnRight = shown ?? lastShown.current;
  // Each time the contents come out they come in from behind the list; another set's, while out, fades across.
  const wasUnfolded = useRef(false);
  const outings = useRef(0);
  if (unfolded && !wasUnfolded.current) outings.current += 1;
  useEffect(() => {
    wasUnfolded.current = unfolded;
  });
  const leftKey = `${nav.view}:${nav.layer?.reference ?? nav.layer?.id ?? ""}:${nav.fromRows ? "rows" : ""}`;
  const firstLeft = useRef(leftKey);
  const moved = useRef(false);
  if (leftKey !== firstLeft.current) moved.current = true;

  const close = onClose;
  const choose = (row: SetListRow): void => {
    if (row.reference === undefined) return;
    if (adding) {
      onAdd(row.reference);
      close();
      return;
    }
    if (still || actions?.onSwap === undefined) return;
    if (!row.current) actions.onSwap(row.reference);
    close();
  };
  const unfold = (key: string | undefined): void => update({ shown: key });
  const backToRows = (): void => update({ view: "rows", fromRows: false, shown: undefined, picked: undefined, query: "" });

  // The keys, on web: ↑ ↓ pick a row, → unfolds it, ← folds it away (or goes back to the rows), ↵ picks.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent): void => {
    if (nav.view !== "list") return;
    const typing = nav.query !== "" && nav.picked === undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = setListStepOf(groups, nav.picked, e.key === "ArrowDown" ? 1 : -1);
      if (next === undefined) return;
      e.preventDefault();
      update({ picked: next, ...(unfolded ? { shown: next } : {}) });
    } else if (e.key === "ArrowRight" && !typing) {
      const target = nav.picked ?? rows.find((row) => row.current)?.key ?? rows[0]?.key;
      if (target === undefined) return;
      e.preventDefault();
      unfold(target);
    } else if (e.key === "ArrowLeft" && !typing) {
      if (unfolded) {
        e.preventDefault();
        unfold(undefined);
      } else if (nav.fromRows) {
        e.preventDefault();
        backToRows();
      }
    } else if (e.key === "Enter") {
      const row = rows.find((each) => each.key === nav.picked) ?? (rows.length === 1 ? rows[0] : undefined);
      if (row === undefined) return;
      e.preventDefault();
      choose(row);
    }
  };
  useEffect(() => {
    if (!isWeb || typeof window === "undefined") return;
    const listen = (e: KeyboardEvent): void => keys.current(e);
    window.addEventListener("keydown", listen, true);
    return () => window.removeEventListener("keydown", listen, true);
  }, []);

  const contentsFoot = (at: Shown): ReactNode => {
    if (adding) {
      return (
        <ContentsFoot note={at.set?.inStack === true ? "Already in the stack." : "Not in the stack."}>
          <VerbButton verb="Lay it on top" disabled={at.reference === undefined} onPress={() => (at.reference !== undefined ? (onAdd(at.reference), close()) : undefined)} />
        </ContentsFoot>
      );
    }
    const owner = at.layer ?? layer;
    const ownerActions = owner !== undefined ? actionsOf(owner) : undefined;
    if (at.own || nav.view === "rows") {
      return (
        <ContentsFoot note={at.layer !== undefined ? undefined : "This is the layer."}>
          {ownerActions?.onEdit !== undefined ? <ActionWord word="edit a copy" title="Open it in Settings → Tools; its first change writes this layer's copy" onPress={() => (ownerActions.onEdit?.(), close())} /> : null}
        </ContentsFoot>
      );
    }
    return (
      <ContentsFoot note="Previewing — the stack is unchanged.">
        {!still && ownerActions?.onSwap !== undefined && owner !== undefined ? (
          <VerbButton verb={`Swap ${owner.id} for this`} disabled={at.reference === undefined} onPress={() => (at.reference !== undefined ? (ownerActions.onSwap?.(at.reference), close()) : undefined)} />
        ) : null}
      </ContentsFoot>
    );
  };

  const contents = (at: Shown, over: boolean): JSX.Element => (
    <ContentsPane host={host} tree={tree} shown={at} over={over} onFold={() => unfold(undefined)} foot={contentsFoot(at)} />
  );

  let left: ReactNode;
  if (cols.over && shown !== undefined) {
    left = contents(shown, true);
  } else if (nav.view === "list") {
    left = (
      <SetListView
        host={host}
        loaded={tree !== undefined}
        groups={groups}
        query={nav.query}
        onQuery={(query) => update({ query, picked: undefined })}
        label={adding ? { words: "Lay on top" } : still ? { words: "is pinned to this project · unpin it to swap", id: layer?.id } : { words: "Swap", id: layer?.id, after: "for" }}
        {...(nav.fromRows ? { onBack: backToRows } : {})}
        still={still}
        picked={nav.picked}
        shown={shown?.key}
        listHeight={listHeight}
        onChoose={choose}
        onUnfold={(key) => unfold(nav.shown === key || shown?.key === key ? undefined : key)}
        foot={
          adding ? (
            <BrowserLinks host={host} onClose={close} />
          ) : actions !== undefined ? (
            <LayerActionsRow actions={actions} onClose={close} />
          ) : null
        }
      />
    );
  } else if (nav.view === "rows") {
    left = (
      <StackRowsView
        rows={panelRows}
        tree={tree}
        shown={nav.shown}
        actionsOf={actionsOf}
        onSwap={(row) => update({ view: "list", layer: holdOf(row), fromRows: true, shown: undefined, picked: undefined, query: "" })}
        onUnfold={(row) => unfold(nav.shown === rowKeyOf(row) ? undefined : rowKeyOf(row))}
        onRemoved={(row) => (nav.shown === rowKeyOf(row) ? unfold(undefined) : undefined)}
        onAdd={() => update({ view: "list", layer: undefined, fromRows: true, shown: undefined, picked: undefined, query: "" })}
        onWhole={() => update({ view: "whole", shown: undefined })}
        host={host}
        onClose={close}
      />
    );
  } else if (nav.view === "board") {
    left =
      board.board !== undefined ? (
        <PermissionBoard
          board={board.board}
          order={nav.order ?? "shield"}
          onToggle={board.onToggle}
          onCommit={board.onCommit}
          by={board.by}
          onBy={board.onBy}
          maxHeight={Math.max(220, anchor.top - 7 - 16 - 150)}
          onWidth={setBoardWidth}
          layers={board.layers}
          {...(nav.order !== "tools" ? { onLayers: () => update({ view: "whole", shown: undefined }) } : onToolList !== undefined ? { onList: onToolList } : {})}
        />
      ) : (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} padding={14}>
          Reading the stack…
        </Txt>
      );
  } else {
    left = (
      <WholePicture
        host={host}
        tree={tree}
        layers={layers}
        tools={tools}
        runtime={runtime}
        actionsOf={actionsOf}
        toolsBody={toolsBody}
        onAdd={onAdd}
        paneHeight={Math.max(240, Math.min(480, anchor.top - 7 - 110))}
        onClose={close}
      />
    );
  }

  return (
    <MorphFloat anchor={anchor} width={cols.left + cols.right + 2} onClose={close}>
      {/* Unfolded, as tall as the room over the bar leaves: the contents beside a short list still have room. */}
      <View flexDirection="row" alignItems="stretch" minHeight={unfolded && !cols.over ? unfoldedHeight : 0}>
        <View width={cols.left} flexShrink={0} overflow="hidden" {...columnMotion()}>
          <View key={cols.over && shown !== undefined ? `over:${shown.key}` : leftKey} width={cols.left} flexDirection="column" {...(moved.current ? arriveMotion("fade") : {})}>
            {left}
          </View>
        </View>
        <View width={cols.right} flexShrink={0} overflow="hidden" position="relative" {...columnMotion()} {...(cols.right > 0 ? (edge(t, { left: 1 }, "panel-2") as object) : {})}>
          {drawnRight !== undefined && !cols.over ? (
            <View key={`${outings.current}:${drawnRight.key}`} position="absolute" top={0} bottom={0} left={0} width={cols.right > 0 ? cols.right : Math.min(500, room - cols.left)} flexDirection="column" {...arriveMotion(wasUnfolded.current && unfolded ? "fade" : "unfold")}>
              {contents(drawnRight, false)}
            </View>
          ) : null}
        </View>
      </View>
    </MorphFloat>
  );
}

/** A list's head: what the list is for, and `‹` back to the rows it was reached from. */
function ListLabel({ words, id, after, onBack }: { words: string; id?: string | undefined; after?: string; onBack?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const upper = { voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" } as const;
  return (
    <View flexDirection="row" alignItems="center" gap={4} paddingTop={onBack !== undefined ? 5 : 9} paddingHorizontal={onBack !== undefined ? 6 : 12} paddingBottom={2} flexWrap="wrap">
      {onBack !== undefined ? (
        <Press onPress={onBack} title="Back to the layers" label="Back to the layers" width={22} height={22} alignItems="center" justifyContent="center" borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-3") : "transparent" })}>
          <Icon name="back" size={13} color={String(t.v("dim"))} />
        </Press>
      ) : null}
      {id !== undefined && after !== undefined ? <Txt spec={upper}>{words}</Txt> : null}
      {id !== undefined ? (
        <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: "dim" }} numberOfLines={1}>
          {id}
        </Txt>
      ) : null}
      <Txt spec={upper}>{id !== undefined && after !== undefined ? after : words}</Txt>
    </View>
  );
}

/** The ›: unfolds a set's contents to the right, and — turned half round, ‹ — folds them away. */
function UnfoldButton({ on, visible, label, onPress }: { on: boolean; visible: boolean; label: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      title={on ? "Fold its contents away" : label}
      label={on ? "Fold its contents away" : label}
      {...({ "aria-expanded": on } as object)}
      width={22}
      height={22}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={6}
      opacity={visible ? 1 : 0}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-3") : "transparent" })}
    >
      {({ hovered }) => (
        <RNView style={{ transform: [{ rotate: on ? "0deg" : "180deg" }] }} {...(turnMotion() as object)}>
          <Icon name="back" size={13} color={String(t.v(on ? "accent" : hovered ? "text" : "tok-hint"))} />
        </RNView>
      )}
    </Press>
  );
}

/** The sets a layer can be swapped for, or laid on top: a find box, the groups, and what is under them. */
function SetListView({
  host,
  loaded,
  groups,
  query,
  onQuery,
  label,
  onBack,
  still,
  picked,
  shown,
  listHeight,
  onChoose,
  onUnfold,
  foot,
}: {
  host: StackCardHost;
  loaded: boolean;
  groups: readonly SetListGroup[];
  query: string;
  onQuery: (query: string) => void;
  label: { words: string; id?: string | undefined; after?: string };
  onBack?: (() => void) | undefined;
  /** Rows to look at, not to pick: a pinned layer's. */
  still: boolean;
  picked: string | undefined;
  shown: string | undefined;
  listHeight: number;
  onChoose: (row: SetListRow) => void;
  onUnfold: (key: string) => void;
  foot: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const hover = useCanHover();
  const phone = usePhone();
  return (
    <View flexDirection="column">
      <ListLabel {...label} onBack={onBack} />
      <View flexDirection="row" alignItems="center" gap={7} marginTop={6} marginHorizontal={8} marginBottom={4} paddingVertical={5} paddingHorizontal={9} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={8} backgroundColor={t.v("bg") as never}>
        <Icon name="search" size={13} color={String(t.v("tok-hint"))} />
        <TextInput
          value={query}
          onChangeText={onQuery}
          placeholder="Find a set"
          placeholderTextColor={placeholderColor("light")}
          accessibilityLabel="Find a set"
          spellCheck={false}
          autoFocus={!phone}
          style={{ ...(font(t, { voice: "app", scale: 12.5 / 12.5, color: "text" }) as object), flex: 1, minWidth: 0, padding: 0, borderWidth: 0, backgroundColor: "transparent", ...(isWeb ? { outlineStyle: "none" } : {}) } as never}
        />
      </View>
      <View maxHeight={listHeight} paddingBottom={4} {...({ overflowY: "auto" } as object)}>
        {!loaded ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={8} paddingHorizontal={12}>
            {host.treeRequest === null ? "No permission sets to browse here." : "…"}
          </Txt>
        ) : groups.length === 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={8} paddingHorizontal={12}>
            {query !== "" ? `No set matches “${query}”.` : "No permission sets here."}
          </Txt>
        ) : (
          groups.map((group) => (
            <View key={group.key} flexDirection="column">
              <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={8} paddingHorizontal={12} paddingBottom={3}>
                {group.near ? `Beside it · ${group.label}` : group.label}
              </Txt>
              {group.rows.map((row) => {
                const out = row.key === shown;
                const keyed = row.key === picked;
                return (
                  <Press
                    key={row.key}
                    {...(still ? {} : { onPress: () => onChoose(row) })}
                    {...(still ? { focusable: false, cursor: "default" } : {})}
                    title={still ? row.id : row.current ? `${row.id} — the layer as it is` : `Use ${row.id}`}
                    flexDirection="row"
                    alignItems="center"
                    gap={9}
                    paddingVertical={5}
                    paddingLeft={8}
                    paddingRight={5}
                    marginHorizontal={4}
                    borderRadius={7}
                    {...(keyed ? { borderWidth: 1, borderStyle: "solid", borderColor: t.mix(t.v("accent"), 45, "transparent") } : { borderWidth: 1, borderStyle: "solid", borderColor: "transparent" })}
                    box={({ hovered }) => ({
                      backgroundColor: row.current ? t.mix(t.v("accent"), 13, "transparent") : out ? t.mix(t.v("accent"), 8, "transparent") : hovered && !still ? t.mix(t.v("text"), 6, "transparent") : "transparent",
                    })}
                  >
                    {({ hovered }) => (
                      <>
                        <Icon name={setIconGlyph(row.icon)} size={14} color={String(t.v(row.current ? "accent" : "dim"))} />
                        <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                          <View flexDirection="row" alignItems="center" gap={6} minWidth={0}>
                            <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.35, color: still && !row.current ? "dim" : "text" }} numberOfLines={1} flexShrink={1}>
                              {row.id}
                            </Txt>
                            {row.inStack && !row.current ? <StackTag /> : null}
                          </View>
                          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: row.problem !== undefined ? "warn" : "tok-hint" }} numberOfLines={1}>
                            {row.problem ?? row.hint}
                          </Txt>
                        </View>
                        {row.current ? <Icon name="check" size={13} color={String(t.v("accent"))} /> : null}
                        <UnfoldButton on={out} visible={!hover || hovered || row.current || out || keyed} label={`What ${row.id} writes`} onPress={() => onUnfold(row.key)} />
                      </>
                    )}
                  </Press>
                );
              })}
            </View>
          ))
        )}
      </View>
      {hover && isWeb ? (
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "tok-hint" }} paddingHorizontal={12} paddingBottom={6}>
          ↑ ↓ pick · → contents · ↵ {still ? "—" : "use"}
        </Txt>
      ) : null}
      {foot}
    </View>
  );
}

/** A layer's own actions, under its list: earlier, later, pin, edit a copy, remove. */
function LayerActionsRow({ actions, onClose }: { actions: LayerActions; onClose: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={12} paddingTop={7} paddingHorizontal={9} paddingBottom={8} {...(edgeTop(t) as object)}>
      {actions.onMove !== undefined ? (
        <>
          <ActionWord word="‹ earlier" title="Move this layer one earlier — under the one before it" disabled={!actions.canEarlier} onPress={() => actions.onMove?.(-1)} />
          <ActionWord word="later ›" title="Move this layer one later — over the one after it" disabled={!actions.canLater} onPress={() => actions.onMove?.(1)} />
        </>
      ) : null}
      {actions.onPin !== undefined ? (
        <ActionWord
          word={actions.pinned ? "unpin from this project" : "pin to this project"}
          title={actions.pinned ? "Take it off this project's standing layers" : "Keep it in this project's stack for every conversation: a standing layer, in settings"}
          onPress={() => void Promise.resolve(actions.onPin?.()).then(onClose)}
        />
      ) : null}
      {actions.onEdit !== undefined ? <ActionWord word="edit a copy" title="Open it in Settings → Tools; its first change writes this layer's copy" onPress={() => (actions.onEdit?.(), onClose())} /> : null}
      {actions.onRemove !== undefined ? <ActionWord word="remove" bad title="Take this layer out of the stack" onPress={() => (actions.onRemove?.(), onClose())} /> : null}
    </View>
  );
}

/** `+`'s foot: Settings, where every set is edited. */
function BrowserLinks({ host, onClose }: { host: StackCardHost; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const app = useShellOrNull();
  return (
    <View flexDirection="row" alignItems="center" justifyContent="flex-end" paddingTop={7} paddingHorizontal={9} paddingBottom={8} {...(edgeTop(t) as object)}>
      {app !== null ? <ActionWord word="open in Settings" title="Settings → Tools, where every permission set is edited" onPress={() => (openSettingsTools(app, host.project), onClose())} /> : null}
    </View>
  );
}

/** A small grey tag: `folded`, `pinned`. */
function GreyTag({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, lineHeight: 1.5, color: "dim" }} flexShrink={0} paddingHorizontal={7} borderRadius={999} backgroundColor={t.v("panel-2") as never} numberOfLines={1}>
      {children}
    </Txt>
  );
}

/** One of a row's small buttons: an icon on nothing, --panel-3 under the pointer. */
function RowButton({ icon, turn, title, bad = false, disabled = false, onPress }: { icon: IconName; turn?: number; title: string; bad?: boolean; disabled?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} disabled={disabled} title={title} label={title} width={22} height={22} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={6} opacity={disabled ? 0.32 : 1} box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("panel-3") : "transparent" })}>
      {({ hovered }) => <Icon name={icon} size={13} color={String(t.v(hovered && !disabled ? (bad ? "bad" : "text") : "tok-hint"))} {...(turn !== undefined ? { box: { transform: [{ rotate: `${turn}deg` }] } } : {})} />}
    </Press>
  );
}

/** `⋯ n`'s panel: a row per layer, newest on top, each with what may be done to it. */
function StackRowsView({
  rows,
  tree,
  shown,
  actionsOf,
  onSwap,
  onUnfold,
  onRemoved,
  onAdd,
  onWhole,
  host,
  onClose,
}: {
  rows: readonly PanelRow[];
  tree: PermissionSetTree | undefined;
  shown: string | undefined;
  actionsOf: (layer: LayerSegment) => LayerActions;
  onSwap: (layer: LayerSegment) => void;
  onUnfold: (layer: LayerSegment) => void;
  onRemoved: (layer: LayerSegment) => void;
  onAdd: () => void;
  onWhole: () => void;
  host: StackCardHost;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const app = useShellOrNull();
  return (
    <View flexDirection="column">
      <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={9} paddingHorizontal={12} paddingBottom={4}>
        The stack · newest on top
      </Txt>
      {rows.map(({ layer, bottom, folded }) => {
        const actions = actionsOf(layer);
        const out = shown === rowKeyOf(layer);
        const standing = layer.role === "standing";
        const hint = layer.problem ?? [bottom ? "bottom" : undefined, standing ? "pinned to this project" : layer.scope, setOfLayer(tree, layer)?.description ?? `${layer.lines} ${layer.lines === 1 ? "line" : "lines"}`].filter((each) => each !== undefined).join(" · ");
        return (
          <View key={layer.key} flexDirection="row" alignItems="center" gap={9} paddingVertical={5} paddingLeft={8} paddingRight={5} marginHorizontal={4} borderRadius={7} backgroundColor={(out ? t.mix(t.v("accent"), 8, "transparent") : "transparent") as never}>
            <Icon name={layer.problem !== undefined ? "alert" : setIconGlyph(layer.icon)} size={14} color={String(t.v(layer.problem !== undefined ? "warn" : "dim"))} />
            <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <View flexDirection="row" alignItems="center" gap={6} minWidth={0}>
                {actions.onSwap !== undefined ? (
                  <Press onPress={() => onSwap(layer)} title={`Swap ${layer.id} for another set`} flexDirection="row" alignItems="center" gap={3} paddingHorizontal={3} marginLeft={-3} borderRadius={5} flexShrink={1} minWidth={0} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-3") : "transparent" })}>
                    <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.35, color: layer.problem !== undefined ? "warn" : "text" }} numberOfLines={1} flexShrink={1}>
                      {layer.id}
                    </Txt>
                    <Icon name="chevron" size={10} color={String(t.v("tok-hint"))} />
                  </Press>
                ) : (
                  <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.35, color: layer.problem !== undefined ? "warn" : "text" }} numberOfLines={1} flexShrink={1}>
                    {layer.id}
                  </Txt>
                )}
                {folded ? <GreyTag>folded</GreyTag> : null}
              </View>
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: layer.problem !== undefined ? "warn" : "tok-hint" }} numberOfLines={1}>
                {hint}
              </Txt>
            </View>
            {standing ? <GreyTag>pinned</GreyTag> : null}
            {actions.onMove !== undefined ? (
              <>
                <RowButton icon="arrow" turn={-90} title="Later — over the one after it" disabled={!actions.canLater} onPress={() => actions.onMove?.(1)} />
                <RowButton icon="arrow" turn={90} title="Earlier — under the one before it" disabled={!actions.canEarlier} onPress={() => actions.onMove?.(-1)} />
              </>
            ) : null}
            {actions.onPin !== undefined ? <RowButton icon="pin" title={actions.pinned ? "Unpin from this project" : "Pin to this project"} onPress={() => void actions.onPin?.()} /> : null}
            {actions.onRemove !== undefined ? (
              <RowButton
                icon="cross"
                bad
                title="Take this layer out of the stack"
                onPress={() => {
                  onRemoved(layer);
                  actions.onRemove?.();
                }}
              />
            ) : null}
            <UnfoldButton on={out} visible label={`What ${layer.id} writes`} onPress={() => onUnfold(layer)} />
          </View>
        );
      })}
      <Press onPress={onAdd} title="Lay a permission set on top" flexDirection="row" alignItems="center" gap={7} marginTop={6} marginHorizontal={8} marginBottom={6} paddingVertical={5} paddingHorizontal={9} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={8} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : t.v("bg") })}>
        <Icon name="search" size={13} color={String(t.v("tok-hint"))} />
        <Txt spec={{ voice: "app", scale: 12.5 / 12.5, color: "tok-hint" }}>Lay a set on top…</Txt>
      </Press>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={12} paddingTop={7} paddingHorizontal={9} paddingBottom={8} {...(edgeTop(t) as object)}>
        <ActionWord word="Whole picture ⤢" title="Every layer and what the stack comes to, beside the scopes" onPress={onWhole} />
        {app !== null ? (
          <View marginLeft="auto">
            <ActionWord word="open in Settings" title="Settings → Tools, where every permission set is edited" onPress={() => (openSettingsTools(app, host.project), onClose())} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The contents unfolded: the set's path as crumbs, what its file writes, and what may be done with it. */
function ContentsPane({ host, tree, shown, over, onFold, foot }: { host: StackCardHost; tree: PermissionSetTree | undefined; shown: Shown; over: boolean; onFold: () => void; foot: ReactNode }): JSX.Element {
  const t = useTokens();
  const at = shown.set !== undefined ? { scope: shown.set.scope, bucket: shown.set.bucket, set: shown.set.id } : undefined;
  return (
    <View flexDirection="column" flexGrow={1} minHeight={0} {...(over ? {} : { height: "100%" })}>
      <View flexDirection="row" alignItems="center" gap={4} paddingVertical={8} paddingHorizontal={9} {...(edge(t, { bottom: 1 }, "panel-2") as object)}>
        {over ? (
          <Press onPress={onFold} title="Back to the list" label="Back to the list" width={22} height={22} alignItems="center" justifyContent="center" borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-3") : "transparent" })}>
            <Icon name="back" size={13} color={String(t.v("dim"))} />
          </Press>
        ) : null}
        <FileGlyph icon={shown.icon} on />
        {tree !== undefined && at !== undefined && at.scope !== "runtime" ? (
          <CrumbPickers tree={tree} crumbs={crumbsOf(tree, at)} still onPick={() => undefined} />
        ) : (
          <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={7} numberOfLines={1} flexShrink={1}>
            {shown.id}
          </Txt>
        )}
        {!over ? (
          <Press
            onPress={onFold}
            title="Fold the contents away"
            label="Fold the contents away"
            marginLeft="auto"
            flexShrink={0}
            paddingVertical={3}
            paddingHorizontal={7}
            borderRadius={6}
            borderWidth={1}
            borderStyle="solid"
            box={({ hovered }) => ({ borderColor: t.mix(t.v("accent"), 50, t.v("line")), backgroundColor: hovered ? t.mix(t.v("accent"), 18, t.v("panel")) : t.mix(t.v("accent"), 12, t.v("panel")) })}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }}>⤡</Txt>
          </Press>
        ) : null}
      </View>
      <View flexGrow={1} flexShrink={1} minHeight={0} paddingTop={7} {...(over ? { maxHeight: 360 } : {})} {...({ overflowY: "auto" } as object)}>
        <SetContents host={host} reference={shown.reference} set={shown.set} />
      </View>
      {foot}
    </View>
  );
}

/** The contents' foot: a note on what this set is to the stack, and what may be done with it, pushed right. */
function ContentsFoot({ note, children }: { note?: string | undefined; children?: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={10} paddingTop={7} paddingHorizontal={9} paddingBottom={9} {...(edgeTop(t) as object)}>
      {note !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} flexShrink={1}>
          {note}
        </Txt>
      ) : null}
      <View flexDirection="row" alignItems="center" gap={10} marginLeft="auto">
        {children}
      </View>
    </View>
  );
}

/** Where a segment's card reads from and writes to — handed down by the composer. */
export interface StackCardHost {
  /** What a tree read is asked with — `null`: no engine, nothing to browse. */
  treeRequest: PermissionSetTreeRequest | null;
  project: string | undefined;
  tools: readonly ToolChoice[];
}

/** The set file glyph: a page with its corner turned, the set's icon in it. */
function FileGlyph({ icon, on }: { icon: string; on: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexShrink={0}
      width={17.6}
      height={22}
      alignItems="center"
      justifyContent="center"
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v(on ? "accent" : "line") as never}
      borderTopLeftRadius={3}
      borderTopRightRadius={8}
      borderBottomLeftRadius={3}
      borderBottomRightRadius={3}
      backgroundColor={(on ? t.mix(t.v("accent"), 10, t.v("panel")) : t.v("panel")) as never}
    >
      <Icon name={setIconGlyph(icon)} size={12} color={String(t.v(on ? "accent" : "dim"))} />
    </View>
  );
}

/**
 * The crumbs that are pickers (§4.1): each drops what sits beside it, and a folder picked drills into
 * what is in it, so a set is reached from any crumb. `onPick` takes the set chosen; `onFolder`, in the
 * browser, follows a folder chosen. `still`: crumbs to read, not to press.
 */
function CrumbPickers({ tree, crumbs, shownAt, onPick, onFolder, still = false }: { tree: PermissionSetTree; crumbs: readonly Crumb[]; shownAt?: string | undefined; onPick: (choice: CrumbChoice) => void; onFolder?: ((at: TreeAt) => void) | undefined; still?: boolean }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={4} minWidth={0} flexShrink={1}>
      {crumbs.map((crumb, i) => (
        <View key={crumb.key} flexDirection="row" alignItems="center" gap={4}>
          {i > 0 ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>›</Txt> : null}
          <CrumbPicker tree={tree} crumb={crumb} lit={shownAt === crumb.key} onPick={onPick} {...(onFolder !== undefined ? { onFolder } : {})} still={still} />
        </View>
      ))}
    </View>
  );
}

function CrumbPicker({ tree, crumb, lit, onPick, onFolder, still }: { tree: PermissionSetTree; crumb: Crumb; lit: boolean; onPick: (choice: CrumbChoice) => void; onFolder?: (at: TreeAt) => void; still: boolean }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  // What the menu lists: the crumb's siblings, or what is in a folder picked from them.
  const [inside, setInside] = useState<{ label: string; choices: CrumbChoice[] } | null>(null);
  const choices = inside?.choices ?? crumb.siblings;
  const close = (): void => {
    setAt(null);
    setInside(null);
  };
  const choose = (choice: CrumbChoice): void => {
    if (choice.kind === "set") {
      onPick(choice);
      close();
      return;
    }
    onFolder?.(choice.at);
    setInside({ label: choice.label, choices: childrenOf(tree, choice.at) });
  };
  const open = at !== null;
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => (still ? undefined : open ? close() : measure(setAt))}
        title={still ? crumb.label : crumb.kind === "set" ? "the sets beside this one" : crumb.kind === "bucket" ? "the buckets beside this one" : "the scopes"}
        {...(still ? { focusable: false, cursor: "default" } : {})}
        flexDirection="row"
        alignItems="center"
        gap={3}
        paddingVertical={2}
        paddingHorizontal={7}
        borderRadius={6}
        box={({ hovered }) => ({ backgroundColor: open || lit ? t.mix(t.v("accent"), 13, "transparent") : hovered && !still ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
      >
        <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5, color: open || lit ? "text" : "dim" }} numberOfLines={1}>
          {crumb.label}
        </Txt>
        {still ? null : <Icon name="chevron" size={12} color={String(t.v("dim"))} />}
      </Press>
      {at !== null ? (
        <SubMenu anchor={at} align="start" minWidth={240} onClose={close}>
          {inside !== null ? (
            <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={6} paddingHorizontal={8} paddingBottom={2}>
              {inside.label}
            </Txt>
          ) : null}
          {choices.length === 0 ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={6} paddingHorizontal={8}>
              nothing here
            </Txt>
          ) : (
            choices.map((choice) => <ChoiceRow key={choice.key} choice={choice} on={choice.key === crumb.on} onPress={() => choose(choice)} />)
          )}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

/** One row of a crumb's menu: a folder (with › — it opens onto what is in it) or a set file. */
function ChoiceRow({ choice, on, onPress }: { choice: CrumbChoice; on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ role: "menuitem" } as object)}
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingVertical={6}
      paddingHorizontal={8}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {choice.kind === "set" ? <FileGlyph icon={choice.icon} on={on} /> : <Icon name={(choice.kind === "scope" ? choice.icon : "folder") as IconName} size={14} color={String(t.v("dim"))} />}
          <View flexDirection="column" gap={1} minWidth={0} flexGrow={1} flexShrink={1}>
            <Txt spec={{ voice: choice.kind === "scope" ? "app" : "data", scale: choice.kind === "scope" ? 12 / 12.5 : 11.5 / 12, weight: 500, lineHeight: 1.3, color: on || hovered ? "text" : "dim" }} numberOfLines={1}>
              {choice.label}
            </Txt>
            {choice.hint !== undefined ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                {choice.hint}
              </Txt>
            ) : null}
          </View>
          {choice.kind !== "set" ? <Icon name="chevron" size={11} color={String(t.v("dim"))} box={{ transform: [{ rotate: "-90deg" }] }} /> : null}
        </>
      )}
    </Press>
  );
}

/** A set's contents (ruling 10): the card, read-only, drawn from the lines its file writes. */
function SetContents({ host, reference, set }: { host: StackCardHost; reference: string | undefined; set: PermissionSetTreeSet | undefined }): JSX.Element {
  const own = useView("permissionSets:own", host.treeRequest !== null && reference !== undefined ? { reference, ...(host.project !== undefined ? { project: host.project } : {}) } : null);
  const permissionSet = useMemo(() => (own.value !== undefined ? ownSetOf(own.value.lines) : undefined), [own.value]);
  const shown = own.value?.set ?? set;
  return (
    <View flexDirection="column" minWidth={0}>
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.35, color: "tok-hint" }} paddingHorizontal={9} paddingBottom={6}>
        {shown !== undefined ? contentsNoteOf(shown) : own.error !== undefined ? String((own.error as unknown as { message?: string }).message ?? own.error) : "…"}
      </Txt>
      {permissionSet !== undefined ? (
        <View paddingHorizontal={9}>
          {/* A new key per set: what is folded open starts again from what the new one writes. */}
          <PermissionSetCard key={reference} permissionSet={permissionSet} tools={host.tools} readOnly />
        </View>
      ) : null}
    </View>
  );
}

/** A row of the layer's actions: a word in --accent (`remove` in --bad, pushed right). */
function ActionWord({ word, title, bad = false, onPress, disabled = false }: { word: string; title?: string; bad?: boolean; onPress: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Press onPress={onPress} disabled={disabled} {...(title !== undefined ? { title } : {})} {...(bad ? { marginLeft: "auto" } : {})} opacity={disabled ? 0.45 : 1} paddingVertical={1}>
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: bad ? "bad" : hovered && !disabled ? "text" : "accent" }} numberOfLines={1}>
          {word}
        </Txt>
      )}
    </Press>
  );
}

/** What a layer's card can do to its layer. */
export interface LayerActions {
  /** Swap the layer for the set picked. Absent for a standing layer, which settings name. */
  onSwap?: ((reference: string) => void) | undefined;
  onMove?: ((by: -1 | 1) => void) | undefined;
  canEarlier: boolean;
  canLater: boolean;
  /** Pin to the project, or take the pin off. Absent where there is no project to pin to. */
  onPin?: (() => void | Promise<void>) | undefined;
  pinned: boolean;
  /** Settings → Tools, where a copy is edited. Absent outside the app. */
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

const edgeTop = (t: Tokens): unknown => edge(t, { top: 1 }, "panel-2");

/** One row of the browser's tree: a scope or a bucket, folding, or a set file with its glyph. */
function TreeRowView({ row, onPress }: { row: TreeRow; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ "aria-expanded": row.kind === "set" ? undefined : row.open } as object)}
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingVertical={row.kind === "set" ? 4 : 6}
      paddingHorizontal={8}
      marginLeft={14 * row.depth}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: row.on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {row.kind !== "set" ? (
        <>
          <Icon name="chevron" size={12} color={String(t.v("dim"))} box={{ transform: [{ rotate: row.open === true ? "0deg" : "-90deg" }] }} />
          <Icon name={(row.kind === "scope" ? row.icon : "folder") as IconName} size={14} color={String(t.v("dim"))} />
          <Txt spec={{ voice: row.kind === "scope" ? "app" : "data", scale: row.kind === "scope" ? 12 / 12.5 : 11.5 / 12, weight: 500 }} numberOfLines={1} flexShrink={1}>
            {row.label}
          </Txt>
          {row.hint !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} marginLeft="auto" numberOfLines={1}>
              {row.hint}
            </Txt>
          ) : null}
        </>
      ) : (
        <>
          <FileGlyph icon={row.icon} on={row.on} />
          <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, lineHeight: 1.3 }} numberOfLines={1}>
              {row.label}
            </Txt>
            {row.hint !== undefined ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                {row.hint}
              </Txt>
            ) : null}
          </View>
          {row.inStack ? <StackTag /> : null}
        </>
      )}
    </Press>
  );
}

/** The browser's foot: `open in Settings` pushed left, then the close button and whatever verbs it is handed. */
function BrowserFoot({ host, onClose, close, children }: { host: StackCardHost; onClose: () => void; close: string; children?: ReactNode }): JSX.Element {
  const t = useTokens();
  const app = useShellOrNull();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="flex-end" gap={8} paddingTop={7} paddingHorizontal={9} paddingBottom={9} {...(edge(t, { top: 1 }, "panel-2") as object)}>
      {app !== null ? (
        <Press
          onPress={() => {
            openSettingsTools(app, host.project);
            onClose();
          }}
          marginRight="auto"
          title="Settings → Tools, where every permission set is edited"
        >
          {({ hovered }) => <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "tok-hint" }}>open in Settings</Txt>}
        </Press>
      ) : (
        <View marginRight="auto" />
      )}
      <Press onPress={onClose} paddingVertical={3} paddingHorizontal={11} borderRadius={7} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never}>
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "dim" }}>{close}</Txt>
      </Press>
      {children}
    </View>
  );
}

/** The browser's verb, on --accent. */
function VerbButton({ verb, disabled, onPress }: { verb: string; disabled: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} disabled={disabled} opacity={disabled ? 0.5 : 1} paddingVertical={3} paddingHorizontal={11} borderRadius={7} backgroundColor={t.v("accent") as never}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "on-accent" }}>{verb}</Txt>
    </Press>
  );
}

/** `in the stack`: a set the stack is built of. */
function StackTag(): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, lineHeight: 1.5, color: "accent" }} flexShrink={0} paddingHorizontal={7} borderRadius={999} backgroundColor={t.mix(t.v("accent"), 13, "transparent") as never} numberOfLines={1}>
      in the stack
    </Txt>
  );
}

/** Settings → Tools, on the layer this window stands on. */
function openSettingsTools(app: AppModel, project: string | undefined): void {
  app.actions.setConfigLayer(project !== undefined ? "project" : "base");
  app.actions.setSection("tools");
  app.actions.setView("settings");
}

/** Settings → Tools, for a caller outside the card (`edit a copy`). */
export function useOpenSettingsTools(project: string | undefined): (() => void) | undefined {
  const app = useShellOrNull();
  return app === null ? undefined : () => openSettingsTools(app, project);
}

/**
 * The shield (2026-11-03): the whole permission picture, drawn in the panel 900 wide. Its tree starts
 * with THIS stack — each layer oldest first, then `tools` — above the scopes. A layer picked shows what
 * its file writes, its crumbs swap it, and its actions are in the foot; `tools` is the Tools card, every
 * line with what this run changed marked; a set picked from a scope can be laid on top.
 */
function WholePicture({
  host,
  tree,
  layers,
  tools,
  runtime,
  actionsOf,
  toolsBody,
  onAdd,
  paneHeight,
  onClose,
}: {
  host: StackCardHost;
  tree: PermissionSetTree | undefined;
  layers: readonly LayerSegment[];
  tools: number;
  runtime: number;
  actionsOf: (layer: LayerSegment) => LayerActions;
  toolsBody: ReactNode;
  onAdd: (reference: string) => void;
  /** How tall the tree and what is beside it stand. */
  paneHeight: number;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const [pick, setPick] = useState<StackPick>({ kind: "tools" });
  // The layer picked, found again as the stack moves: by its key, else by what it names.
  const [picked, setPicked] = useState<LayerSegment | undefined>(undefined);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const layer = pick.kind === "layer" ? (layers.find((each) => each.key === pick.key) ?? layers.find((each) => picked !== undefined && each.reference === picked.reference && each.role === picked.role)) : undefined;
  const at = pick.kind === "set" ? pick.at : undefined;
  // Until a set is picked, the bottom layer's bucket stands open: what sits beside it is the likeliest pick.
  const near = tree !== undefined && layers[0] !== undefined ? treeAtOf(tree, layers[0].reference, layers[0].id) : undefined;
  const rows = tree !== undefined ? treeRowsOf(tree, toggled, at ?? (near !== undefined ? { scope: near.scope, bucket: near.bucket } : undefined)) : [];
  const set = tree !== undefined ? setAtOf(tree, at) : undefined;
  const reference = set !== undefined ? referenceOfPick(set) : undefined;
  const layerAt = tree !== undefined && layer !== undefined ? treeAtOf(tree, layer.reference, layer.id) : undefined;
  const actions = layer !== undefined ? actionsOf(layer) : undefined;
  const choose = (next: StackPick, segment?: LayerSegment): void => {
    setPick(next);
    setPicked(segment);
  };
  return (
    <View flexDirection="column">
      <View flexDirection="row" alignItems="center" gap={4} paddingVertical={8} paddingHorizontal={9} {...(edge(t, { bottom: 1 }, "panel-2") as object)}>
        {pick.kind === "tools" ? (
          <>
            <Icon name="tool" size={14} color={String(t.v("accent"))} />
            <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={5} numberOfLines={1}>
              tools
            </Txt>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} numberOfLines={1} flexShrink={1}>
              what the whole stack comes to{runtime > 0 ? " — what this run changed is marked" : ""}
            </Txt>
          </>
        ) : layer !== undefined ? (
          <>
            <FileGlyph icon={layer.icon} on />
            {tree !== undefined && layerAt !== undefined ? (
              <CrumbPickers
                tree={tree}
                crumbs={crumbsOf(tree, layerAt)}
                still={actions?.onSwap === undefined}
                onPick={(choice) => {
                  const next = choice.set !== undefined ? referenceOfPick(choice.set) : undefined;
                  if (next !== undefined) actions?.onSwap?.(next);
                }}
              />
            ) : (
              <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={7} numberOfLines={1}>
                {layer.id}
              </Txt>
            )}
          </>
        ) : set !== undefined && tree !== undefined && at !== undefined ? (
          <>
            <FileGlyph icon={set.icon} on />
            <CrumbPickers tree={tree} crumbs={crumbsOf(tree, at)} shownAt={crumbsOf(tree, at).at(-1)?.key} onPick={(choice) => choice.set !== undefined && choose({ kind: "set", at: choice.at })} onFolder={(next) => choose({ kind: "set", at: next })} />
          </>
        ) : (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "tok-hint" }} paddingHorizontal={7}>
            pick a layer, the tools, or a permission set
          </Txt>
        )}
      </View>
      <View flexDirection={phone ? "column" : "row"} height={phone ? undefined : paneHeight} minHeight={0}>
        <View
          {...(phone ? { maxHeight: 200, ...(edge(t, { bottom: 1 }, "panel-2") as object) } : { width: 300, flexShrink: 0, ...(edge(t, { right: 1 }, "panel-2") as object) })}
          paddingVertical={4}
          paddingRight={4}
          paddingLeft={4}
          {...({ overflowY: "auto" } as object)}
        >
          {stackRowsOf(layers, tools, runtime).map((row) => {
            const on = row.pick !== undefined && (row.pick.kind === "tools" ? pick.kind === "tools" : row.pick.kind === "layer" && layer !== undefined && row.layer?.key === layer.key);
            if (row.kind === "root") {
              return (
                <View key={row.key} flexDirection="row" alignItems="center" gap={9} paddingVertical={6} paddingHorizontal={8}>
                  <Icon name="shield" size={14} color={String(t.v("dim"))} />
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500 }} numberOfLines={1} flexShrink={1}>
                    {row.label}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} marginLeft="auto" numberOfLines={1}>
                    {row.hint}
                  </Txt>
                </View>
              );
            }
            return (
              <Press
                key={row.key}
                onPress={() => (row.pick !== undefined ? choose(row.pick, row.layer) : undefined)}
                flexDirection="row"
                alignItems="center"
                gap={9}
                paddingVertical={4}
                paddingHorizontal={8}
                marginLeft={14 * row.depth}
                borderRadius={7}
                box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
              >
                {row.kind === "tools" ? <Icon name="tool" size={14} color={String(t.v(on ? "accent" : "dim"))} /> : <FileGlyph icon={row.icon} on={on} />}
                <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, lineHeight: 1.3 }} numberOfLines={1}>
                    {row.label}
                  </Txt>
                  {row.hint !== undefined ? (
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                      {row.hint}
                    </Txt>
                  ) : null}
                </View>
              </Press>
            );
          })}
          <View height={1} marginVertical={5} marginHorizontal={8} backgroundColor={t.v("panel-2") as never} />
          {tree === undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={6} paddingHorizontal={8}>
              {host.treeRequest === null ? "No permission sets to browse here." : "…"}
            </Txt>
          ) : (
            rows.map((row) => <TreeRowView key={row.key} row={row} onPress={() => (row.kind === "set" ? choose({ kind: "set", at: row.at }) : setToggled((was) => ({ ...was, [row.key]: !(row.open ?? false) })))} />)
          )}
        </View>
        <View flexGrow={1} flexShrink={1} minWidth={0} paddingTop={7} {...(phone ? { maxHeight: 360 } : {})} {...({ overflowY: "auto" } as object)}>
          {pick.kind === "tools" ? (
            <View paddingHorizontal={9} paddingBottom={6}>
              {toolsBody}
            </View>
          ) : layer !== undefined ? (
            <SetContents host={host} reference={layer.reference} set={tree !== undefined ? setAtOf(tree, layerAt) : undefined} />
          ) : set !== undefined ? (
            <SetContents host={host} reference={set.explicit ?? reference} set={set} />
          ) : (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingHorizontal={9}>
              Pick a layer, the tools, or a set on the left.
            </Txt>
          )}
        </View>
      </View>
      <BrowserFoot host={host} onClose={onClose} close="Done">
        {actions !== undefined ? (
          <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={12} marginRight={4}>
            {actions.onMove !== undefined ? (
              <>
                <ActionWord word="‹ earlier" title="Move this layer one earlier — under the one before it" disabled={!actions.canEarlier} onPress={() => actions.onMove?.(-1)} />
                <ActionWord word="later ›" title="Move this layer one later — over the one after it" disabled={!actions.canLater} onPress={() => actions.onMove?.(1)} />
              </>
            ) : null}
            {actions.onPin !== undefined ? <ActionWord word={actions.pinned ? "unpin from this project" : "pin to this project"} onPress={() => void actions.onPin?.()} /> : null}
            {actions.onRemove !== undefined ? (
              <ActionWord
                word="remove"
                bad
                title="Take this layer out of the stack"
                onPress={() => {
                  actions.onRemove?.();
                  choose({ kind: "tools" });
                }}
              />
            ) : null}
          </View>
        ) : null}
        {pick.kind === "set" ? (
          <VerbButton
            verb="Lay it on top"
            disabled={reference === undefined}
            onPress={() => {
              if (reference === undefined) return;
              onAdd(reference);
              choose({ kind: "tools" });
            }}
          />
        ) : null}
      </BrowserFoot>
    </View>
  );
}

/** The Tools card's head switch (§7.4, round 6's design 7): `This conversation` | `Everything`. */
export function ToolsSwitch({ everything, onEverything }: { everything: boolean; onEverything: (next: boolean) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={7} overflow="hidden" backgroundColor={t.v("panel") as never} {...({ role: "tablist" } as object)}>
      {[false, true].map((all, i) => {
        const on = everything === all;
        return (
          <Press
            key={String(all)}
            onPress={() => onEverything(all)}
            {...({ role: "tab", "aria-selected": on } as object)}
            paddingVertical={3}
            paddingHorizontal={9}
            {...(i > 0 ? (edge(t, { left: 1 }) as object) : {})}
            box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.v("panel-2") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: on ? 650 : 500, color: on ? "text" : "dim" }} numberOfLines={1}>
              {all ? "Everything" : "This conversation"}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/**
 * "Save this stack as a set" (§7.4), in Everything's head: a name and where it goes, asked through the
 * schema form; `Save` keeps the stack's layers and its tools layer's lines as a file of the bucket.
 */
export function SaveStack({ bucket, layers, onSave }: { bucket: string; layers: readonly WritableSetLayer[]; onSave: ((name: string, layer: WritableSetLayer) => Promise<void>) | undefined }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  const [draft, setDraft] = useState<{ name?: string; where?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const where = layers.map((layer) => KEEP_WHERE[layer]);
  const schema: Schema = {
    type: "object",
    properties: { name: { type: "string", title: "name", minLength: 1 }, where: { type: "string", title: "where", enum: where, default: where[0] } },
    required: ["name", "where"],
  };
  const ready = onSave !== undefined && layers.length > 0;
  const save = (): void => {
    const name = (draft.name ?? "").trim();
    const layer = layers.find((candidate) => KEEP_WHERE[candidate] === (draft.where ?? where[0]));
    if (name === "" || layer === undefined || onSave === undefined) {
      setProblem(name === "" ? "name it" : "pick where it goes");
      return;
    }
    setSaving(true);
    setProblem(null);
    void onSave(name, layer).then(
      () => {
        setSaving(false);
        setSaved(permissionSetIdAt(bucket, name));
        setDraft({});
        setAt(null);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, marginLeft: "auto", ...NO_STACK } as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        disabled={!ready}
        title={ready ? `Save this stack as a permission set ${bucket === "" ? "at the top level" : `in ${bucket}`}: its layers, and this conversation's lines` : "There is nowhere to save a set here"}
        paddingHorizontal={7}
        borderRadius={999}
        opacity={ready ? 1 : 0.45}
        backgroundColor={t.mix(t.v("accent"), 13, "transparent") as never}
      >
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.5, color: "accent" }} numberOfLines={1}>
          {saved !== null ? `saved as ${saved}` : "save this stack as a set"}
        </Txt>
      </Press>
      {at !== null && ready ? (
        <SubMenu anchor={at} align="end" minWidth={270} padding={9} gap={7} onClose={() => setAt(null)}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }}>
            Keep this stack — its layers, and this conversation's lines — as a permission set in <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 700, color: "tok-hint" }}>{bucket}</Txt>
          </Txt>
          <SchemaForm schema={schema} value={{ where: where[0], ...draft }} onChange={(next) => setDraft((next ?? {}) as { name?: string; where?: string })} ctx={{ path: "", hidePaths: true, disabled: saving }} />
          {problem !== null ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} maxWidth={300}>
              {problem}
            </Txt>
          ) : null}
          <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
            <Press onPress={save} disabled={saving} paddingVertical={4} paddingHorizontal={13} borderRadius={7} backgroundColor={t.v("accent") as never} {...(saving ? { opacity: 0.5 } : {})}>
              <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, color: "on-accent" }}>Save</Txt>
            </Press>
          </View>
        </SubMenu>
      ) : null}
    </RNView>
  );
}
