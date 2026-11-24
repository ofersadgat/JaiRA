import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent, type JSX, type ReactNode } from "react";
import { ScrollView, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import {
  BOARD_ANSWERS,
  moveOf,
  RESULT,
  type Board,
  type BoardAnswer,
  type BoardChip,
  type BoardLayer,
  type BoardRow,
  type BoardRowRef,
  type LineEdit,
} from "@jaira/ui/permissionBoard";
import { layerActsOf } from "@jaira/ui/permissionBoard";
import type { LayerHost, SetChoice } from "@jaira/ui/permissionBoardHost";
import type { WritableSetLayer } from "@jaira/shared/browser";
import { TextInput } from "react-native";
import { font } from "../../primitives";
import { SubMenu, useAnchorRect } from "./ComposerCards";
import { Press, Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Icon, type IconName } from "../panel/Icon";

/**
 * The permission board (decision 0034): a conversation's permissions as a grid of places, a row per
 * resource, access and tool, a column per answer, and the stack's layers as column groups beside the
 * Result — every layer merged. The model is `permissionBoard.ts`; this draws it, opens a chip in the
 * inspector when it is pressed, and turns a drag (web) or the inspector's answers into a move.
 *
 * Two orders (2026-11-23): from the shield it BUILDS UP — the root set, each layer on top of it, oldest
 * to newest, then the Result, frozen on the right; from the tools segment it starts from the Result
 * alone, frozen on the left, and "Show the source permission sets" lays the layers out beside it, newest
 * first. A column no chip is in is not drawn — but This conversation's, where a move on the Result lands.
 *
 * How it looks (treatment A, "bands and threads"):
 *
 *   the bar           row, gap 10, padding 8 12, a --panel-2 line under it; the order's words app 11 --tok-hint
 *   group head        app 12/650, a 10px swatch in the layer's hue, a 3px top edge in it; hint app 10 --tok-hint
 *   answer head       app 10.5/600, a 7px dot in the answer's colour
 *   label column      240 wide, frozen on web (sticky)
 *   a resource        52 tall, its kind's colour at 13% over --panel, a 2px top edge at 40%, a 5px left edge;
 *                     a 28 tile filled with its colour, its name app 14.5/700, its accesses data 10 --tok-hint
 *   an access         40 tall, --panel; a 2px thread at 28 in its colour at 55%; a pill: app 12/650 in its
 *                     colour, at 15% over --panel, its colour at 50% around, radius 7, padding 3 9, its icon 12
 *   a tool            28 tall, --panel-3 at 75% over --panel, a --panel-3 rule above; data 10.5 --dim, threads
 *   a cell            108 wide (132 alone in its layer, 150 folded), 112 in the Result; its answer at 4% over
 *   a chip            data 10.5/500, its kind's colour at 8% over --panel, at 30% around, radius 6, padding 3 5;
 *                     the Result's has a 3px left edge in the hue of the layer that answered; one a newer layer
 *                     overrules is at 42% and struck through; MIXED is --warn; a place set is app 11/600
 *   the inspector     300 wide beside the grid, a --panel-2 line left of it; sections padding 10 14
 */

const LABEL_W = 240;
const TOOL_LABEL_W = 320;
const RESULT_W = 112;
const LAYER_W = 108;
const LONE_W = 132;
const FOLDED_W = 150;
const INSPECTOR_W = 300;

const ANSWER_HUE: Readonly<Record<BoardAnswer, string>> = { allow: "ok", smart: "p3", ask: "warn", deny: "bad", off: "dim" };
const ANSWER_WORD: Readonly<Record<BoardAnswer, string>> = { allow: "Allow", smart: "Smart", ask: "Ask", deny: "Deny", off: "Off" };
const RESOURCE_HUE: Readonly<Record<string, string>> = { files: "ws-read", commands: "p3", sites: "p1", repositories: "p2", programs: "ws-run", services: "p2", packages: "warn", machine: "p0", workflows: "ws-tool", skills: "p3", artifacts: "ws-tool", other: "ws-tool", "cat:files": "ws-read", "cat:execution": "p3", "cat:system": "ws-run", "cat:web": "p1", "cat:git": "p2", "cat:ci": "p2", "cat:tasks": "ws-tool", "cat:mcp": "ws-tool", "cat:other": "ws-tool" };
const KIND_HUE: Readonly<Record<string, string>> = { path: "ws-read", host: "ws-read", site: "p1", branch: "p3", repository: "p2", workflow: "ws-tool", program: "ws-run", owner: "ws-tool", action: "p3", area: "p2", service: "p2", package: "warn", manager: "warn", machine: "p0", any: "tok-hint", tool: "ws-tool", set: "accent" };
const KIND_ICON: Readonly<Record<string, IconName>> = { path: "folder", host: "drive", site: "web", branch: "git", repository: "repo", workflow: "workflow", program: "terminal", owner: "user", action: "play", area: "sliders", service: "gear", package: "package", manager: "package", machine: "system", any: "any", tool: "tool", set: "layers" };

/** A layer's hue on the board: the root grey, standing amber, named blue, the run green, the conversation the accent. */
function layerHue(layer: BoardLayer | undefined): string {
  if (layer === undefined) return "text";
  if (layer.role === "runtime") return "ws-run";
  if (layer.writes === "conversation") return "accent";
  if (layer.role === "bottom") return "p0";
  if (layer.role === "standing") return "p2";
  if (layer.scope === "this state") return "ws-tool";
  return "p1";
}

const icon = (name: string): IconName => (name as IconName) ?? "tool";
const answerWordOf = (decision: string): BoardAnswer => (decision === "allow" || decision === "ask" || decision === "deny" ? decision : decision === "unavailable" ? "off" : "smart");

/** One column of the grid. */
interface Column {
  group: string;
  answer: BoardAnswer | "*";
  width: number;
  first: boolean;
  last: boolean;
  result: boolean;
  /** Where it is frozen, on web: `left` or `right`, in px. */
  stick?: { side: "left" | "right"; at: number };
}

export interface PermissionBoardProps {
  board: Board;
  order: "shield" | "tools";
  onToggle: (ref: BoardRowRef) => void;
  /** Write a move's edits; resolves when written, rejects with what went wrong. */
  onCommit: (edits: LineEdit[]) => Promise<void>;
  /** The shield's way back to its picture of the layers. */
  onLayers?: () => void;
  /** The Tools card's list of tools, for what the board does not do (ticking a tool off). */
  onList?: () => void;
  /** Rows by resource, or by tool (round 2's switch). */
  by?: "resources" | "tools";
  onBy?: (by: "resources" | "tools") => void;
  /** How tall the grid may stand before it scrolls — its heads stay while it does. */
  maxHeight?: number;
  /** How wide the board needs to be, told whenever it changes: the panel is no wider. */
  onWidth?: (width: number) => void;
  /** What the layer heads do to the conversation's stack; without it the heads only fold. */
  layers?: LayerHost;
}

/** A layer act waiting on the person: Replace or Merge, taking an unsaved layer's lines away, a set's name. */
type LayerAsk =
  | { kind: "swap"; layer: BoardLayer; set: SetChoice }
  | { kind: "remove"; layer: BoardLayer }
  | { kind: "save"; layer: BoardLayer; name: string; where: WritableSetLayer | undefined };

/** A chip being looked at or dragged, and where it is. */
type Held = { row: string; rowLabel: string; column: string; chip: BoardChip };
type Pending = { says: string; ask: string; edits: LineEdit[] };

export function PermissionBoard({ board, order, onToggle, onCommit, onLayers, onList, by = "resources", onBy, maxHeight, onWidth, layers }: PermissionBoardProps): JSX.Element {
  const t = useTokens();
  const labelW = by === "tools" ? TOOL_LABEL_W : LABEL_W;
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(order === "tools" ? board.layers.filter((layer) => layer.role === "bottom").map((layer) => layer.key) : []));
  const [sources, setSources] = useState(order === "shield");
  const [dragged, setDragged] = useState<Held | undefined>(undefined);
  const [inspected, setInspected] = useState<Held | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [draggedLayer, setDraggedLayer] = useState<BoardLayer | undefined>(undefined);
  const [layerAsk, setLayerAsk] = useState<LayerAsk | undefined>(undefined);
  /** A layer act run: what it did said, or why nothing was. */
  const runLayer = (act: () => void | Promise<void>, says: string): void => {
    setLayerAsk(undefined);
    setInspected(undefined);
    Promise.resolve()
      .then(act)
      .then(() => setNotice(says))
      .catch((error: unknown) => setNotice(`Nothing was changed: ${error instanceof Error ? error.message : String(error)}`));
  };
  const [headHeight, setHeadHeight] = useState(56);
  const [sectionHeights, setSectionHeights] = useState<Readonly<Record<string, number>>>({});

  // The answers each column group has a chip in, over every row.
  const usedOf = useMemo(() => {
    const out = new Map<string, Set<BoardAnswer>>();
    for (const row of board.rows) for (const [group, chips] of Object.entries(row.cells)) for (const chip of chips) (out.get(group) ?? out.set(group, new Set()).get(group)!).add(chip.answer);
    return out;
  }, [board]);

  const columns = useMemo((): Column[] => {
    // A column no chip is in is not drawn; This conversation's and an unsaved layer's always are — a move lands there.
    const answersOf = (group: string, always: boolean): BoardAnswer[] => (always ? [...BOARD_ANSWERS] : BOARD_ANSWERS.filter((answer) => usedOf.get(group)?.has(answer)));
    const layerGroup = (layer: BoardLayer): Column[] => {
      if (folded.has(layer.key)) return [{ group: layer.key, answer: "*", width: FOLDED_W, first: true, last: true, result: false }];
      const list = answersOf(layer.key, layer.writes === "conversation" || layer.writes === "unsaved");
      return list.map((answer, at) => ({ group: layer.key, answer, width: list.length === 1 ? LONE_W : LAYER_W, first: at === 0, last: at === list.length - 1, result: false }));
    };
    const resultAnswers = answersOf(RESULT, false);
    const result: Column[] = resultAnswers.map((answer, at) => ({ group: RESULT, answer, width: RESULT_W, first: at === 0, last: at === resultAnswers.length - 1, result: true }));
    const shown = sources ? board.layers : [];
    const groups = order === "shield" ? [...shown.flatMap(layerGroup), ...result] : [...result, ...[...shown].reverse().flatMap(layerGroup)];
    // Frozen: the Result beside the labels (Tools) or at the right end (shield).
    const resultCols = groups.filter((column) => column.result);
    resultCols.forEach((column, at) => {
      column.stick = order === "shield" ? { side: "right", at: resultCols.slice(at + 1).reduce((sum, each) => sum + each.width, 0) } : { side: "left", at: labelW + resultCols.slice(0, at).reduce((sum, each) => sum + each.width, 0) };
    });
    return groups;
  }, [board.layers, folded, usedOf, sources, order, labelW]);

  // The Result alone (the Tools view, sources hidden): no head over it — there is nothing else to name.
  const alone = !columns.some((column) => !column.result);
  const layerOf = (key: string | undefined): BoardLayer | undefined => board.layers.find((layer) => layer.key === key);
  const gridWidth = labelW + columns.reduce((sum, column) => sum + column.width + (column.first ? 2 : 1), 0);
  const width = gridWidth + (inspected !== undefined ? INSPECTOR_W + 1 : 0) + 2;
  useEffect(() => onWidth?.(width), [width, onWidth]);

  const tryMove = (from: Held, to: { group: string; answer: BoardAnswer | "*" }): void => {
    setDragged(undefined);
    setOver(undefined);
    const answer = to.answer === "*" ? from.chip.answer : to.answer;
    if (from.column === to.group && from.chip.answer === answer) return;
    const move = moveOf(board, from.chip, from.column, { column: to.group, answer });
    if (!move.ok) return setNotice(move.says);
    setInspected(undefined);
    if (move.ask !== undefined) return setPending({ says: move.says, ask: move.ask, edits: move.edits });
    commit(move.edits, move.says);
  };
  const commit = (edits: LineEdit[], says: string): void => {
    setPending(undefined);
    setBusy(true);
    onCommit(edits)
      .then(() => setNotice(says))
      .catch((error: unknown) => setNotice(`Nothing was written: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setBusy(false));
  };

  const groupsOf = (list: readonly Column[]): Array<{ group: string; span: number; width: number; first: Column }> => {
    const out: Array<{ group: string; span: number; width: number; first: Column }> = [];
    for (const column of list) {
      const last = out.at(-1);
      if (last !== undefined && last.group === column.group) {
        last.span += 1;
        last.width += column.width;
      } else out.push({ group: column.group, span: 1, width: column.width, first: column });
    }
    return out;
  };

  const sticky = (stick: Column["stick"] | "label", z = 2): Record<string, unknown> => {
    if (!isWeb || stick === undefined) return {};
    if (stick === "label") return { style: { position: "sticky", left: 0, zIndex: z + 1 } };
    return { style: { position: "sticky", [stick.side]: stick.at, zIndex: z } };
  };

  const head = (
    <View flexDirection="column" onLayout={(e: { nativeEvent: { layout: { height: number } } }) => setHeadHeight(Math.round(e.nativeEvent.layout.height))} {...(isWeb ? { style: { position: "sticky", top: 0, zIndex: 6 } } : {})}>
      {alone ? null : (
      <View flexDirection="row">
        <View width={labelW} flexShrink={0} backgroundColor={t.v("panel") as never} {...(sticky("label") as object)} />
        {groupsOf(columns).map((group) => {
          const result = group.group === RESULT;
          const layer = layerOf(group.group);
          const hue = result ? "text" : layerHue(layer);
          const isFolded = !result && folded.has(group.group);
          const stick = result ? (order === "shield" ? { side: "right" as const, at: 0 } : { side: "left" as const, at: labelW }) : undefined;
          if (!result && layer !== undefined && layers !== undefined)
            return (
              <LayerHead
                key={group.group}
                t={t}
                layer={layer}
                width={group.width}
                wide={group.span > 1}
                hue={hue}
                folded={isFolded}
                host={layers}
                dragged={draggedLayer}
                onFold={() => setFolded((was) => toggled(was, group.group))}
                onDrag={setDraggedLayer}
                onDropOn={(target) => {
                  if (draggedLayer !== undefined && draggedLayer.key !== target.key) layers.moveBefore(draggedLayer, target);
                  setDraggedLayer(undefined);
                }}
                onSwap={(set) => {
                  if (layers.holdsLines(layer)) setLayerAsk({ kind: "swap", layer, set });
                  else runLayer(() => layers.swap(layer, set, "replace"), `${layer.label} → ${set.id}.`);
                }}
                onAct={(act) => {
                  if (act === "add") return runLayer(() => layers.addBefore(layer), `A new layer before ${layer.label}, kept with this conversation.`);
                  if (act === "earlier" || act === "later") return runLayer(() => layers.moveBy(layer, act === "earlier" ? -1 : 1), `${layer.label} moved ${act}.`);
                  if (act === "remove") return layers.holdsLines(layer) ? setLayerAsk({ kind: "remove", layer }) : runLayer(() => layers.remove(layer), `${layer.label} taken off this conversation.`);
                  if (act === "save") return setLayerAsk({ kind: "save", layer, name: "", where: layers.saveTo.find((each) => each.layer === "project")?.layer ?? layers.saveTo[0]?.layer });
                  if (act === "clear") return runLayer(() => layers.clear(), "This conversation's own lines cleared.");
                  if (act === "forget") return runLayer(() => layers.forget(), "This run's answers forgotten.");
                  if (act === "unpin") return runLayer(() => layers.unpin(layer), `${layer.label} unpinned from this project.`);
                }}
              />
            );
          return (
            <Press
              key={group.group}
              onPress={() => (result ? undefined : setFolded((was) => toggled(was, group.group)))}
              title={result ? "Every layer, merged" : `${layer?.hint ?? ""}${layer?.readOnly !== undefined ? ` · read-only: ${layer.readOnly}` : ""} — fold or unfold`}
              label={result ? "Result" : (layer?.label ?? group.group)}
              width={group.width}
              flexShrink={0}
              grow={false}
              box={() => ({ paddingTop: 7, paddingBottom: 3, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: t.v("panel"), borderTopWidth: 3, borderTopColor: t.v(hue), borderLeftWidth: 2, borderLeftColor: t.v(hue), ...((sticky(stick, 4) as { style?: object }).style ?? {}) })}
            >
              {!result ? <Icon name="chevron" size={10} color={String(t.v("tok-hint"))} box={isFolded ? { transform: [{ rotate: "-90deg" }] } : undefined} /> : null}
              <View width={10} height={10} borderRadius={3} backgroundColor={t.v(hue) as never} />
              <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 650 }} ellip flexShrink={1}>
                {result ? "Result" : (layer?.label ?? group.group)}
              </Txt>
              {group.span > 1 || result ? (
                <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "tok-hint" }} ellip flexShrink={1}>
                  {result ? (order === "shield" ? "what the conversation has" : "every layer, merged") : layer?.hint}
                </Txt>
              ) : null}
            </Press>
          );
        })}
      </View>
      )}
      <View flexDirection="row" borderBottomWidth={1} borderBottomColor={t.v("line") as never}>
        <View width={labelW} flexShrink={0} paddingHorizontal={12} paddingBottom={5} justifyContent="flex-end" backgroundColor={t.v("panel") as never} {...(sticky("label") as object)}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600 }}>{by === "tools" ? "Tool" : "Resource"}</Txt>
        </View>
        {columns.map((column) => (
          <View
            key={`${column.group}:${column.answer}`}
            width={column.width}
            flexShrink={0}
            paddingHorizontal={7}
            paddingBottom={5}
            flexDirection="row"
            alignItems="center"
            gap={5}
            backgroundColor={t.v("panel") as never}
            borderLeftWidth={column.first ? 2 : 0}
            borderLeftColor={t.v(column.result ? "text" : layerHue(layerOf(column.group))) as never}
            {...(sticky(column.stick, 3) as object)}
          >
            <View width={7} height={7} borderRadius={4} backgroundColor={t.v(column.answer === "*" ? layerHue(layerOf(column.group)) : ANSWER_HUE[column.answer]) as never} />
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: column.answer === "*" ? "dim" : ANSWER_HUE[column.answer] }} ellip>
              {column.answer === "*" ? "every answer" : ANSWER_WORD[column.answer]}
            </Txt>
          </View>
        ))}
      </View>
    </View>
  );

  const bar = (
    <View flexDirection="row" alignItems="center" gap={10} paddingVertical={8} paddingHorizontal={12} flexWrap="wrap" borderBottomWidth={1} borderBottomColor={t.v("panel-2") as never}>
      <Icon name={order === "shield" ? "shield" : "tool"} size={14} color={String(t.v("dim"))} />
      <Txt spec={{ voice: "app", scale: 12.5 / 12.5, weight: 600 }}>{order === "shield" ? "Permissions" : "Tools"}</Txt>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} flexShrink={1} ellip>
        {order === "shield" ? "the root set, each layer on top of it, then what the conversation has" : "what this conversation may do"}
      </Txt>
      <View flex={1} />
      {onBy !== undefined ? (
        <View flexDirection="row" borderRadius={7} borderWidth={1} borderColor={t.v("line") as never} overflow="hidden">
          {(["resources", "tools"] as const).map((each) => (
            <Press key={each} onPress={() => onBy(each)} label={each === "resources" ? "By resource" : "By tool"} role="radio" aria-checked={by === each} grow={false} box={({ hovered }) => ({ paddingVertical: 3, paddingHorizontal: 10, backgroundColor: by === each ? t.tint("accent", 12) : hovered ? t.v("panel-2") : "transparent" })}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: by === each ? 600 : 500, color: by === each ? "text" : "dim" }}>{each === "resources" ? "Resources" : "Tools"}</Txt>
            </Press>
          ))}
        </View>
      ) : null}
      {order === "tools" ? <BarButton t={t} words={sources ? "Hide the source permission sets" : "Show the source permission sets"} onPress={() => setSources((was) => !was)} /> : null}
      {onList !== undefined ? <BarButton t={t} words="Tool list…" onPress={onList} /> : null}
      {onLayers !== undefined ? <BarButton t={t} words="Layers and sets…" onPress={onLayers} /> : null}
    </View>
  );

  // An open section's row stays under the heads while its rows scroll past, until the next section's
  // pushes it away (2026-11-23): each open section is a block of its own, its row sticky inside it — an
  // access's under its resource's.
  const rowOf = (row: Board["rows"][number], stickTop?: number, onHeight?: (height: number) => void): JSX.Element => (
    <Row
      key={row.key}
      t={t}
      row={row}
      {...(stickTop !== undefined ? { stickTop } : {})}
      {...(onHeight !== undefined ? { onHeight } : {})}
      columns={columns}
      alone={alone}
      board={board}
      labelW={labelW}
      dragged={dragged}
      inspected={inspected}
      over={over}
      sticky={sticky}
      onToggle={onToggle}
      onDrag={setDragged}
      onInspect={(held) => setInspected((was) => (was !== undefined && was.row === held.row && was.column === held.column && was.chip.id === held.chip.id ? undefined : held))}
      onOver={setOver}
      onDrop={tryMove}
    />
  );
  const rows: JSX.Element[] = [];
  for (let at = 0; at < board.rows.length; ) {
    const top = board.rows[at]!;
    let end = at + 1;
    while (end < board.rows.length && board.rows[end]!.level > top.level) end += 1;
    const under = board.rows.slice(at + 1, end);
    at = end;
    if (!top.open || under.length === 0) {
      rows.push(rowOf(top), ...under.map((each) => rowOf(each)));
      continue;
    }
    const topHeight = sectionHeights[top.key] ?? 52;
    const parts: JSX.Element[] = [rowOf(top, headHeight, (height) => setSectionHeights((was) => (was[top.key] === height ? was : { ...was, [top.key]: height })))];
    for (let i = 0; i < under.length; ) {
      const sub = under[i]!;
      let stop = i + 1;
      while (stop < under.length && under[stop]!.level > sub.level) stop += 1;
      const tools = under.slice(i + 1, stop);
      i = stop;
      if (sub.open && tools.length > 0)
        parts.push(
          <View key={`section:${sub.key}`} flexDirection="column">
            {rowOf(sub, headHeight + topHeight)}
            {tools.map((each) => rowOf(each))}
          </View>,
        );
      else parts.push(rowOf(sub), ...tools.map((each) => rowOf(each)));
    }
    rows.push(
      <View key={`section:${top.key}`} flexDirection="column">
        {parts}
      </View>,
    );
  }

  return (
    <View flexDirection="column" minWidth={0}>
      {bar}
      {layerAsk !== undefined && layers !== undefined ? <LayerAskStrip t={t} ask={layerAsk} host={layers} onAsk={setLayerAsk} run={runLayer} /> : null}
      {pending !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={10} paddingVertical={8} paddingHorizontal={12} backgroundColor={t.mix(t.v("warn"), 9, t.v("panel")) as never}>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }} flexShrink={1}>
            {pending.says} {pending.ask}
          </Txt>
          <View flex={1} />
          <BarButton t={t} words="Cancel" onPress={() => setPending(undefined)} />
          <BarButton t={t} words="Change it" strong onPress={() => commit(pending.edits, pending.says)} />
        </View>
      ) : null}
      <View flexDirection="row" alignItems="stretch" minWidth={0}>
        <View flex={1} minWidth={0}>
          {isWeb ? (
            <View {...({ style: { overflow: "auto", ...(maxHeight !== undefined ? { maxHeight } : {}) } } as object)}>
              <View flexDirection="column" width={gridWidth} {...(busy ? { opacity: 0.6 } : {})}>
                {head}
                {rows}
              </View>
            </View>
          ) : (
            <ScrollView {...(maxHeight !== undefined ? { style: { maxHeight } } : {})}>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View flexDirection="column" width={gridWidth} {...(busy ? { opacity: 0.6 } : {})}>
                  {head}
                  {rows}
                </View>
              </ScrollView>
            </ScrollView>
          )}
        </View>
        {inspected !== undefined ? <Inspector t={t} board={board} held={inspected} onClose={() => setInspected(undefined)} onMove={(to) => tryMove(inspected, to)} onInspect={(chip) => setInspected({ ...inspected, chip })} /> : null}
      </View>
      <View paddingVertical={7} paddingHorizontal={12} minHeight={30} borderTopWidth={1} borderTopColor={t.v("panel-2") as never}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{notice ?? "Press a chip to see where it comes from and change it, or drag it to another column in its row. A move on the Result is kept with this conversation; a move into a set changes the set."}</Txt>
      </View>
    </View>
  );
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function BarButton({ t, words, onPress, strong = false }: { t: Tokens; words: string; onPress: () => void; strong?: boolean }): JSX.Element {
  return (
    <Press onPress={onPress} label={words} grow={false} box={({ hovered }) => ({ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 7, backgroundColor: strong ? t.v("fill-accent") : hovered ? t.tint("accent", 9) : "transparent" })}>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 500, color: strong ? "on-accent" : "accent" }}>{words}</Txt>
    </Press>
  );
}

/** A row's colours by its level. */
function rowGround(t: Tokens, row: BoardRow): string {
  const hue = t.v(RESOURCE_HUE[row.resource] ?? "dim");
  if (row.level === 1) return t.mix(hue, 13, t.v("panel"));
  if (row.level === 3) return t.mix(t.v("panel-3"), 75, t.v("panel"));
  return String(t.v("panel"));
}

function Row({
  t,
  row,
  columns,
  alone,
  board,
  labelW,
  dragged,
  inspected,
  over,
  sticky,
  onToggle,
  onDrag,
  onInspect,
  onOver,
  onDrop,
  stickTop,
  onHeight,
}: {
  t: Tokens;
  row: Board["rows"][number];
  columns: readonly Column[];
  alone: boolean;
  board: Board;
  labelW: number;
  dragged: Held | undefined;
  inspected: Held | undefined;
  over: string | undefined;
  sticky: (stick: Column["stick"] | "label", z?: number) => Record<string, unknown>;
  onToggle: (ref: BoardRowRef) => void;
  onDrag: (held: Held | undefined) => void;
  onInspect: (held: Held) => void;
  onOver: (key: string | undefined) => void;
  onDrop: (from: Held, to: { group: string; answer: BoardAnswer | "*" }) => void;
  /** Open, its section's row stays this far from the top while the section scrolls past (web). */
  stickTop?: number;
  onHeight?: (height: number) => void;
}): JSX.Element {
  const hue = String(t.v(RESOURCE_HUE[row.resource] ?? "dim"));
  const ground = rowGround(t, row);
  const thread = t.mix(hue, 55, "transparent");
  const height = row.level === 1 ? 52 : row.level === 2 ? 40 : 28;

  const label = (
    <Press
      onPress={() => (row.opens ? onToggle(row.ref) : undefined)}
      label={row.label}
      title={row.opens ? (row.open ? "Fold" : "Open") : row.label}
      width={labelW}
      flexShrink={0}
      grow={false}
      box={() => ({
        minHeight: height,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: row.level === 1 ? 16 : row.level === 2 ? 46 : 74,
        paddingRight: 10,
        backgroundColor: ground,
        ...(row.level === 1 ? { borderLeftWidth: 5, borderLeftColor: hue } : {}),
        ...((sticky("label") as { style?: object }).style ?? {}),
      })}
    >
      {row.level >= 2 ? <View position="absolute" left={28} top={0} width={2} {...(row.level === 2 && row.last && !row.open ? { height: "50%" } : { bottom: 0 })} backgroundColor={thread as never} /> : null}
      {row.level === 2 ? <View position="absolute" left={28} top="50%" width={12} height={2} backgroundColor={thread as never} /> : null}
      {row.level === 3 ? (
        <>
          <View position="absolute" left={54} top={0} width={1.5} {...(row.last ? { height: "50%" } : { bottom: 0 })} backgroundColor={thread as never} />
          <View position="absolute" left={54} top="50%" width={10} height={1.5} backgroundColor={thread as never} />
        </>
      ) : null}
      {row.opens ? <Icon name="chevron" size={10} color={String(t.v("tok-hint"))} box={row.open ? undefined : { transform: [{ rotate: "-90deg" }] }} /> : row.level === 2 ? <View width={10} /> : null}
      {row.level === 1 ? (
        <View width={28} height={28} borderRadius={8} backgroundColor={hue as never} alignItems="center" justifyContent="center">
          <Icon name={icon(row.icon)} size={15} color={String(t.v("panel"))} />
        </View>
      ) : null}
      {row.level === 2 ? (
        <View flexDirection="row" alignItems="center" gap={5} paddingVertical={3} paddingHorizontal={9} borderRadius={7} borderWidth={1} borderColor={t.mix(hue, 50, "transparent") as never} backgroundColor={t.mix(hue, 15, t.v("panel")) as never} {...(row.resource === "other" || row.resource.startsWith("cat:") ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 })}>
          <Icon name={icon(row.icon)} size={12} color={hue} />
          <Txt spec={{ voice: row.resource === "other" || row.resource.startsWith("cat:") ? "data" : "app", scale: 12 / 12.5, weight: 650, color: hue }} ellip>
            {row.label}
          </Txt>
        </View>
      ) : null}
      {row.level === 3 ? <Icon name="tool" size={11} color={String(t.v("tok-hint"))} /> : null}
      <View flexDirection="column" minWidth={0} flexShrink={1}>
        {row.level === 1 ? <Txt spec={{ voice: "app", scale: 14.5 / 12.5, weight: 700 }}>{row.label}</Txt> : null}
        {row.level === 3 ? (
          <View flexDirection="row" alignItems="center" gap={5}>
            <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: "dim" }} ellip>
              {row.label}
            </Txt>
            {row.also.length > 0 ? (
              <View paddingHorizontal={6} borderRadius={99} borderWidth={1} borderStyle="dashed" borderColor={t.tint("accent", 45) as never}>
                <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 500, color: "accent" }}>+ {row.also.join(", ")}</Txt>
              </View>
            ) : null}
          </View>
        ) : null}
        {row.sub !== "" && row.level !== 3 ? (
          <Txt spec={{ voice: "data", scale: 10 / 12, color: "tok-hint" }} ellip>
            {row.sub}
          </Txt>
        ) : null}
      </View>
    </Press>
  );

  return (
    <View
      flexDirection="row"
      backgroundColor={ground as never}
      {...(row.level === 1 ? { borderTopWidth: 2, borderTopColor: t.mix(hue, 40, t.v("line")) as never } : row.level === 3 ? { borderTopWidth: 1, borderTopColor: t.v("panel-3") as never } : { borderTopWidth: 1, borderTopColor: t.v("panel-2") as never })}
      {...(onHeight !== undefined ? { onLayout: (e: { nativeEvent: { layout: { height: number } } }) => onHeight(Math.round(e.nativeEvent.layout.height)) } : {})}
      {...(isWeb && stickTop !== undefined ? { style: { position: "sticky", top: stickTop, zIndex: row.level === 1 ? 5 : 4 }, "data-stuck": row.key } : {})}
    >
      {label}
      {columns.map((column) => {
        const chips = (row.cells[column.group] ?? []).filter((chip) => column.answer === "*" || chip.answer === column.answer);
        const cellKey = `${row.key}|${column.group}|${column.answer}`;
        const isOver = over === cellKey && dragged !== undefined && dragged.row === row.key;
        const tint = row.level === 2 && column.answer !== "*" ? t.mix(t.v(ANSWER_HUE[column.answer]), 4, ground) : ground;
        const web = isWeb
          ? {
              onDragOver: (e: ReactDragEvent) => {
                if (dragged === undefined || dragged.row !== row.key) return;
                e.preventDefault();
                if (over !== cellKey) onOver(cellKey);
              },
              onDrop: (e: ReactDragEvent) => {
                if (dragged === undefined || dragged.row !== row.key) return;
                e.preventDefault();
                onDrop(dragged, { group: column.group, answer: column.answer });
              },
              // What a rig finds a cell by (shots/README: never a class).
              "data-cell": cellKey,
            }
          : {};
        return (
          <View
            key={cellKey}
            width={column.width}
            flexShrink={0}
            minHeight={height}
            paddingVertical={3}
            paddingHorizontal={4}
            flexDirection="row"
            flexWrap="wrap"
            alignItems="center"
            alignContent="center"
            backgroundColor={(isOver ? t.tint("accent", 16) : tint) as never}
            borderLeftWidth={column.first ? 2 : 1}
            borderLeftColor={(column.first ? t.v(column.result ? "text" : layerHue(board.layers.find((layer) => layer.key === column.group))) : t.v("panel-2")) as never}
            {...(web as object)}
            {...(isWeb && column.stick !== undefined ? { style: { position: "sticky", [column.stick.side]: column.stick.at, zIndex: 2 } } : {})}
          >
            {chips.map((chip) => {
              const held: Held = { row: row.key, rowLabel: row.label, column: column.group, chip };
              const open = inspected !== undefined && inspected.row === row.key && inspected.column === column.group && inspected.chip.id === chip.id;
              return <Chip key={chip.id} t={t} chip={chip} column={column} board={board} open={open} onInspect={() => onInspect(held)} onDragStart={() => onDrag(held)} onDragEnd={() => onDrag(undefined)} />;
            })}
          </View>
        );
      })}
    </View>
  );
}

function Chip({ t, chip, column, board, open, onInspect, onDragStart, onDragEnd }: { t: Tokens; chip: BoardChip; column: Column; board: Board; open: boolean; onInspect: () => void; onDragStart: () => void; onDragEnd: () => void }): JSX.Element {
  const hue = String(t.v(KIND_HUE[chip.kind] ?? "dim"));
  const from = chip.from !== undefined ? board.layers.find((layer) => layer.key === chip.from) : undefined;
  const overruledBy = chip.overruled !== undefined ? board.layers.find((layer) => layer.key === chip.overruled) : undefined;
  const title = chip.overruled !== undefined ? `overruled by ${overruledBy?.label ?? "a newer layer"}` : column.result ? (chip.mixed === true ? "its tools disagree here" : from !== undefined ? `from ${from.label}` : "what applies when no layer says") : chip.set !== undefined ? chip.set.places.join(", ") : chip.label;
  const isSet = chip.set !== undefined;
  const body: ReactNode = (
    <>
      {column.answer === "*" ? <View width={7} height={7} borderRadius={4} backgroundColor={t.v(ANSWER_HUE[chip.answer]) as never} /> : null}
      <Icon name={KIND_ICON[chip.kind] ?? "any"} size={11} color={hue} />
      <Txt spec={{ voice: isSet ? "app" : "data", scale: isSet ? 11 / 12.5 : 10.5 / 12, weight: isSet ? 600 : 500, ...(chip.overruled !== undefined ? { color: "dim" } : {}) }} ellip flexShrink={1} {...(chip.overruled !== undefined ? { textDecorationLine: "line-through" } : {})}>
        {chip.label}
      </Txt>
      {chip.tags !== undefined && chip.tags.length > 0 ? (
        <View flexDirection="row" gap={1}>
          {chip.tags.map((tag) => (
            <View key={tag.label} padding={2} borderRadius={3} backgroundColor={t.v("panel-3") as never}>
              <Icon name={icon(tag.icon)} size={9} color={String(t.v("dim"))} />
            </View>
          ))}
        </View>
      ) : null}
      {chip.part !== undefined ? (
        <Txt spec={{ voice: "app", scale: 9 / 12.5, color: "tok-hint" }} flexShrink={0} numberOfLines={1}>
          {chip.part}
        </Txt>
      ) : null}
      {chip.mixed === true ? (
        <View paddingHorizontal={3} borderRadius={3} borderWidth={1} borderColor={t.tint("warn", 50) as never}>
          <Txt spec={{ voice: "app", scale: 8.5 / 12.5, weight: 700, color: "warn" }}>MIXED</Txt>
        </View>
      ) : null}
      {column.result && from?.writes === "conversation" ? (
        <View width={14} height={14} borderRadius={4} backgroundColor={t.v("fill-accent") as never} alignItems="center" justifyContent="center">
          <Icon name="pin" size={9} color={String(t.v("on-accent"))} />
        </View>
      ) : null}
    </>
  );
  const box = {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    margin: 2,
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: chip.kind === "any" ? "dashed" : "solid",
    borderColor: chip.mixed === true ? t.tint("warn", 55) : t.mix(hue, 30, "transparent"),
    backgroundColor: chip.mixed === true ? t.mix(t.v("warn"), 12, t.v("panel")) : t.mix(hue, 8, t.v("panel")),
    maxWidth: "100%",
    ...(column.result && from !== undefined ? { borderLeftWidth: 3, borderLeftColor: t.v(layerHue(from)) } : {}),
    ...(chip.overruled !== undefined ? { opacity: 0.42 } : {}),
    ...(open ? { borderColor: t.v("accent"), boxShadow: `0 0 0 2px ${String(t.tint("accent", 30))}` } : {}),
  };
  if (isWeb) {
    const web = {
      draggable: true,
      title,
      "data-chip": `${column.group}|${chip.place}`,
      role: "button",
      "aria-label": `${chip.label}, ${chip.answer}`,
      cursor: "pointer",
      userSelect: "none",
      onDragStart: (e: ReactDragEvent) => {
        e.dataTransfer?.setData("text/plain", chip.label);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        onDragStart();
      },
      onDragEnd,
      onClick: (e: { stopPropagation: () => void }) => {
        e.stopPropagation();
        onInspect();
      },
    };
    return (
      <View {...(web as object)} {...(box as object)}>
        {body}
      </View>
    );
  }
  return (
    <Press onPress={onInspect} label={`${chip.label}, ${chip.answer}`} title={title} grow={false} box={() => box}>
      {body}
    </Press>
  );
}

/**
 * The inspector: a chip pressed — what it stands for, where its answer comes from, and its answer to
 * change. A move from here is the same as a drag: on the Result it is kept with this conversation, in a
 * set's layer it changes the set (asked first).
 */
function Inspector({ t, board, held, onClose, onMove, onInspect }: { t: Tokens; board: Board; held: Held; onClose: () => void; onMove: (to: { group: string; answer: BoardAnswer | "*" }) => void; onInspect: (chip: BoardChip) => void }): JSX.Element {
  const { chip } = held;
  const result = held.column === RESULT;
  const layer = board.layers.find((each) => each.key === held.column);
  const from = chip.from !== undefined ? board.layers.find((each) => each.key === chip.from) : undefined;
  const overruledBy = chip.overruled !== undefined ? board.layers.find((each) => each.key === chip.overruled) : undefined;
  const subjects = [...new Set(chip.lines.map((line) => line.subject))];
  const hue = String(t.v(KIND_HUE[chip.kind] ?? "dim"));
  const readOnly = !result && layer?.writes === "none";
  const section = (title: string, children: ReactNode): JSX.Element => (
    <View paddingVertical={10} paddingHorizontal={14} borderTopWidth={1} borderTopColor={t.v("panel-2") as never} gap={6}>
      <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }}>{title}</Txt>
      {children}
    </View>
  );
  const word = (words: string, color = "dim"): JSX.Element => <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color, lineHeight: 1.4 }}>{words}</Txt>;
  const targets = board.layers.filter((each) => each.writes !== "none" && each.key !== held.column && !(result && each.writes === "conversation"));
  return (
    <View width={INSPECTOR_W} flexShrink={0} borderLeftWidth={1} borderLeftColor={t.v("panel-2") as never} backgroundColor={t.v("panel") as never} {...(isWeb ? { "data-inspector": "" } : {})}>
      <View flexDirection="row" alignItems="center" gap={8} paddingTop={12} paddingHorizontal={14} paddingBottom={8}>
        <Icon name={KIND_ICON[chip.kind] ?? "any"} size={14} color={hue} />
        <Txt spec={{ voice: chip.set !== undefined ? "app" : "data", scale: 12.5 / 12.5, weight: 650 }} ellip flexShrink={1}>
          {chip.label}
        </Txt>
        <View paddingHorizontal={6} paddingVertical={2} borderRadius={5} backgroundColor={t.tint(ANSWER_HUE[chip.answer], 14) as never}>
          <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, color: ANSWER_HUE[chip.answer] }}>{chip.decision}</Txt>
        </View>
        <View flex={1} />
        <Press onPress={onClose} label="Close the inspector" title="Close" grow={false} box={({ hovered }) => ({ width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: hovered ? t.v("panel-3") : "transparent" })}>
          <Icon name="cross" size={11} color={String(t.v("tok-hint"))} />
        </Press>
      </View>
      <View paddingHorizontal={14} paddingBottom={10} gap={3}>
        {word(`${held.rowLabel} · ${result ? "Result" : (layer?.label ?? "")}`)}
        {result
          ? chip.mixed === true
            ? word("Its tools disagree here; it is drawn at the strictest.", "warn")
            : word(from !== undefined ? `Answered by ${from.label}${from.writes === "conversation" ? ", kept with this conversation" : ""}.` : "No layer says it: what applies when nothing is set.")
          : overruledBy !== undefined
            ? word(`Overruled by ${overruledBy.label}, which says otherwise here.`, "warn")
            : word(readOnly ? `Read-only: ${layer?.readOnly ?? ""}.` : layer?.writes === "set" ? "A change here changes the set for every conversation that uses it." : "Kept with this conversation.")}
      </View>
      {section(
        result ? "Answer, for this conversation" : "Answer, in this layer",
        <View flexDirection="row" borderRadius={8} borderWidth={1} borderColor={t.v("line") as never} overflow="hidden">
          {BOARD_ANSWERS.map((answer) => {
            const on = chip.answer === answer;
            return (
              <Press
                key={answer}
                onPress={() => onMove({ group: held.column, answer })}
                disabled={readOnly}
                label={ANSWER_WORD[answer]}
                flex={1}
                grow={false}
                box={({ hovered }) => ({ paddingVertical: 5, alignItems: "center", borderRightWidth: answer === "off" ? 0 : 1, borderRightColor: t.v("line"), backgroundColor: on ? t.tint(ANSWER_HUE[answer], 16) : hovered && !readOnly ? t.v("panel-2") : "transparent" })}
              >
                <Txt spec={{ voice: "data", scale: 10 / 12, weight: on ? 700 : 500, color: on ? ANSWER_HUE[answer] : readOnly ? "tok-hint" : "dim" }}>{answer}</Txt>
              </Press>
            );
          })}
        </View>,
      )}
      {chip.mixed === true && chip.answers !== undefined
        ? section(
            "What each tool comes to",
            <View gap={3}>
              {chip.answers.map((each) => (
                <View key={each.subject} flexDirection="row" alignItems="center" gap={6}>
                  <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} flexShrink={1} ellip>
                    {each.subject}
                  </Txt>
                  <View flex={1} />
                  <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, color: ANSWER_HUE[answerWordOf(each.decision)] }}>{each.decision}</Txt>
                </View>
              ))}
            </View>,
          )
        : null}
      {chip.members !== undefined && chip.set !== undefined
        ? section(
            `${chip.set.label} · ${chip.members.length} place${chip.members.length === 1 ? "" : "s"}`,
            <View flexDirection="row" flexWrap="wrap" gap={4}>
              {chip.members.map((member) => (
                <Press key={member.id} onPress={() => onInspect(member)} label={`look at ${member.label} alone`} title="Look at it alone, to give it its own answer" grow={false} box={({ hovered }) => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6, borderWidth: 1, borderColor: t.mix(t.v(KIND_HUE[member.kind] ?? "dim"), 30, "transparent"), backgroundColor: hovered ? t.v("panel-2") : t.v("panel") })}>
                  <Icon name={KIND_ICON[member.kind] ?? "any"} size={10} color={String(t.v(KIND_HUE[member.kind] ?? "dim"))} />
                  <Txt spec={{ voice: "data", scale: 10 / 12 }}>{member.label}</Txt>
                </Press>
              ))}
            </View>,
          )
        : null}
      {!readOnly && targets.length > 0
        ? section(
            result ? "Keep it in a set" : "Move it to",
            <View flexDirection="row" flexWrap="wrap" gap={4}>
              {targets.map((each) => (
                <Press key={each.key} onPress={() => onMove({ group: each.key, answer: "*" })} label={`to ${each.label}`} grow={false} box={({ hovered }) => ({ paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: t.tint(layerHue(each), 40), backgroundColor: hovered ? t.tint(layerHue(each), 10) : "transparent" })}>
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 500 }}>{each.label}</Txt>
                </Press>
              ))}
            </View>,
          )
        : null}
      {section(
        `Sets ${subjects.length} tool${subjects.length === 1 ? "" : "s"}`,
        <View flexDirection="row" flexWrap="wrap" gap={4}>
          {subjects.map((subject) => (
            <View key={subject} paddingVertical={2} paddingHorizontal={6} borderRadius={5} backgroundColor={t.v("panel-2") as never}>
              <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }}>{subject}</Txt>
            </View>
          ))}
        </View>,
      )}
    </View>
  );
}

// --- the layer heads (2026-11-23) ----------------------------------------------------------------

type LayerAct = "add" | "earlier" | "later" | "remove" | "save" | "clear" | "forget" | "unpin";

/**
 * A layer's head, where the conversation's stack is changed: its NAME swaps it for another set (a menu
 * of every set), its SWATCH drags it along the stack (web), a + on its left edge — on hover — adds a new
 * unsaved layer just before it, and its ⋯ holds the rest: add before, move earlier or later, save as a
 * set, clear, forget, unpin, remove. The chevron folds its columns. This run and This conversation stay
 * where they are.
 *
 *   the +          18 round, --fill-accent, --on-accent glyph, on the head's left edge, over the line
 *   the swatch     10 square, radius 3, in the layer's hue; a grab cursor where it can be dragged
 *   the name       app 12/650, a 9 chevron after it where it swaps; hovered --panel-2 behind it
 *   ⋯              20 square, radius 5, --dim; hovered --panel-3
 *   a drop target  the head at 12% accent, while another layer is dragged over it
 */
function LayerHead({
  t,
  layer,
  width,
  wide,
  hue,
  folded,
  host,
  dragged,
  onFold,
  onDrag,
  onDropOn,
  onSwap,
  onAct,
}: {
  t: Tokens;
  layer: BoardLayer;
  width: number;
  wide: boolean;
  hue: string;
  folded: boolean;
  host: LayerHost;
  dragged: BoardLayer | undefined;
  onFold: () => void;
  onDrag: (layer: BoardLayer | undefined) => void;
  onDropOn: (target: BoardLayer) => void;
  onSwap: (set: SetChoice) => void;
  onAct: (act: LayerAct) => void;
}): JSX.Element {
  const acts = layerActsOf(layer);
  const [hovered, setHovered] = useState(false);
  const [menu, setMenu] = useState<{ which: "swap" | "more"; at: { left: number; top: number; right: number; bottom: number } } | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [swapRef, measureSwap] = useAnchorRect();
  const [moreRef, measureMore] = useAnchorRect();
  const target = dragged !== undefined && dragged.key !== layer.key && (acts.move || layer.role === "runtime" || layer.writes === "conversation");
  const web = isWeb
    ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        ...(target
          ? {
              onDragOver: (e: ReactDragEvent) => e.preventDefault(),
              onDrop: (e: ReactDragEvent) => {
                e.preventDefault();
                onDropOn(layer);
              },
            }
          : {}),
        "data-layer-head": layer.label,
      }
    : {};
  const shown = host.sets.filter((set) => query.trim() === "" || set.id.toLowerCase().includes(query.trim().toLowerCase()));
  const items: Array<{ act: LayerAct; words: string; bad?: boolean }> = [
    ...(acts.addBefore ? [{ act: "add" as const, words: "Add a layer before it" }] : []),
    ...(acts.move ? [{ act: "earlier" as const, words: "Move earlier" }, { act: "later" as const, words: "Move later" }] : []),
    ...(acts.save && host.saveTo.length > 0 ? [{ act: "save" as const, words: "Save as a set…" }] : []),
    ...(acts.clear ? [{ act: "clear" as const, words: "Clear its lines" }] : []),
    ...(acts.forget ? [{ act: "forget" as const, words: "Forget this run's answers" }] : []),
    ...(acts.unpin ? [{ act: "unpin" as const, words: "Unpin from this project" }] : []),
    ...(acts.remove ? [{ act: "remove" as const, words: "Remove from this conversation", bad: true }] : []),
  ];
  return (
    <View
      width={width}
      flexShrink={0}
      position="relative"
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingTop={7}
      paddingBottom={3}
      paddingLeft={8}
      paddingRight={4}
      backgroundColor={(target ? t.mix(t.v("accent"), 12, t.v("panel")) : t.v("panel")) as never}
      borderTopWidth={3}
      borderTopColor={t.v(hue) as never}
      borderLeftWidth={2}
      borderLeftColor={t.v(hue) as never}
      {...(web as object)}
    >
      {acts.addBefore && (hovered || !isWeb) ? (
        <Press onPress={() => onAct("add")} label={`Add a layer before ${layer.label}`} title="Add a new layer here, kept with this conversation" grow={false} position="absolute" left={-10} top={6} zIndex={3} box={() => ({ width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: t.v("fill-accent"), borderWidth: 2, borderColor: t.v("panel") })}>
          <Icon name="plus" size={10} color={String(t.v("on-accent"))} />
        </Press>
      ) : null}
      <Press onPress={onFold} label={folded ? `Unfold ${layer.label}` : `Fold ${layer.label}`} title="Fold or unfold its columns" grow={false} box={() => ({ width: 12, alignItems: "center" })}>
        <Icon name="chevron" size={10} color={String(t.v("tok-hint"))} box={folded ? { transform: [{ rotate: "-90deg" }] } : undefined} />
      </Press>
      <View
        width={10}
        height={10}
        borderRadius={3}
        flexShrink={0}
        backgroundColor={t.v(hue) as never}
        {...((isWeb && acts.move
          ? {
              draggable: true,
              title: "Drag to move this layer",
              cursor: "grab",
              "data-layer-handle": layer.label,
              onDragStart: (e: ReactDragEvent) => {
                e.dataTransfer?.setData("text/plain", layer.key);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                onDrag(layer);
              },
              onDragEnd: () => onDrag(undefined),
            }
          : {}) as object)}
      />
      <RNView ref={swapRef} collapsable={false} style={{ flexShrink: 1, minWidth: 0 }}>
        {acts.swap ? (
          <Press
            onPress={() => measureSwap((at) => setMenu({ which: "swap", at }))}
            label={`Swap ${layer.label}`}
            title="Swap it for another set"
            grow={false}
            box={({ hovered: on }) => ({ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 3, borderRadius: 5, backgroundColor: on || menu?.which === "swap" ? t.v("panel-2") : "transparent", minWidth: 0 })}
          >
            <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 650 }} ellip flexShrink={1}>
              {layer.label}
            </Txt>
            <Icon name="chevron" size={9} color={String(t.v("tok-hint"))} />
          </Press>
        ) : (
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 650 }} ellip flexShrink={1} paddingHorizontal={3}>
            {layer.label}
          </Txt>
        )}
      </RNView>
      {wide ? (
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "tok-hint" }} ellip flexShrink={1}>
          {layer.hint}
        </Txt>
      ) : null}
      <View flex={1} />
      {items.length > 0 ? (
        <RNView ref={moreRef} collapsable={false}>
          <Press onPress={() => measureMore((at) => setMenu({ which: "more", at }))} label={`More for ${layer.label}`} title="More" grow={false} box={({ hovered: on }) => ({ width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 5, backgroundColor: on || menu?.which === "more" ? t.v("panel-3") : "transparent" })}>
            <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 700, color: "dim", lineHeight: 1 }}>⋯</Txt>
          </Press>
        </RNView>
      ) : null}
      {menu?.which === "swap" ? (
        <SubMenu anchor={menu.at} align="start" minWidth={280} onClose={() => setMenu(undefined)}>
          <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={4} paddingHorizontal={8}>
            {layer.unsaved !== undefined ? "Start from, or swap for" : `Swap ${layer.label} for`}
          </Txt>
          <TextInput value={query} onChangeText={setQuery} placeholder="Find a set" autoFocus style={{ ...(font(t, { voice: "data", scale: 11 / 12 }) as object), margin: 4, paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: String(t.v("line")), borderRadius: 7 }} />
          {shown.slice(0, 12).map((set) => {
            const current = set.id === layer.id;
            return (
              <Press
                key={set.id}
                onPress={() => {
                  setMenu(undefined);
                  if (!current) onSwap(set);
                }}
                label={`${set.id}, ${set.where}`}
                grow={false}
                box={({ hovered: on }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, backgroundColor: on ? t.tint("accent", 9) : "transparent" })}
              >
                <Icon name="layers" size={12} color={String(t.v(current ? "accent" : "dim"))} />
                <Txt spec={{ voice: "data", scale: 11 / 12, weight: current ? 700 : 500 }} flexShrink={1} ellip>
                  {set.id}
                </Txt>
                <View flex={1} />
                <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "tok-hint" }}>{current ? "current" : set.where}</Txt>
              </Press>
            );
          })}
          {shown.length === 0 ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} padding={8}>
              No set is named so.
            </Txt>
          ) : null}
        </SubMenu>
      ) : null}
      {menu?.which === "more" ? (
        <SubMenu anchor={menu.at} align="end" minWidth={220} onClose={() => setMenu(undefined)}>
          {items.map((item) => (
            <Press
              key={item.act}
              onPress={() => {
                setMenu(undefined);
                onAct(item.act);
              }}
              label={item.words}
              grow={false}
              box={({ hovered: on }) => ({ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: on ? t.tint(item.bad === true ? "bad" : "accent", 9) : "transparent" })}
            >
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: item.bad === true ? "bad" : "text" }}>{item.words}</Txt>
            </Press>
          ))}
        </SubMenu>
      ) : null}
    </View>
  );
}

/** What a layer act waits on: Replace or Merge, losing an unsaved layer's lines, a set's name and place. */
function LayerAskStrip({ t, ask, host, onAsk, run }: { t: Tokens; ask: LayerAsk; host: LayerHost; onAsk: (ask: LayerAsk | undefined) => void; run: (act: () => void | Promise<void>, says: string) => void }): JSX.Element {
  const strip = (words: ReactNode, buttons: ReactNode): JSX.Element => (
    <View flexDirection="row" alignItems="center" gap={10} flexWrap="wrap" paddingVertical={8} paddingHorizontal={12} backgroundColor={t.mix(t.v("accent"), 7, t.v("panel")) as never} {...((isWeb ? { "data-layer-ask": ask.kind } : {}) as object)}>
      <View flexDirection="row" alignItems="center" gap={8} flexShrink={1} flexWrap="wrap">
        {words}
      </View>
      <View flex={1} />
      <BarButton t={t} words="Cancel" onPress={() => onAsk(undefined)} />
      {buttons}
    </View>
  );
  const say = (words: string): JSX.Element => <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }}>{words}</Txt>;
  if (ask.kind === "swap")
    return strip(
      say(`${ask.layer.label} has lines of its own. Replace them with ${ask.set.id}, or merge ${ask.set.id} into them — its answers win where both say one?`),
      <>
        <BarButton t={t} words="Merge" onPress={() => run(() => host.swap(ask.layer, ask.set, "merge"), `${ask.set.id} merged into ${ask.layer.label}.`)} />
        <BarButton t={t} words="Replace" strong onPress={() => run(() => host.swap(ask.layer, ask.set, "replace"), `${ask.layer.label} → ${ask.set.id}.`)} />
      </>,
    );
  if (ask.kind === "remove")
    return strip(say(`${ask.layer.label} has lines kept only with this conversation. Removing it loses them.`), <BarButton t={t} words="Remove" strong onPress={() => run(() => host.remove(ask.layer), `${ask.layer.label} taken off this conversation.`)} />);
  const name = ask.name.trim();
  const problem = name === "" ? "a set needs a name" : !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(name) ? "lower case, digits, - and _, folders with /" : host.sets.some((set) => set.id === name) ? `there is a set named ${name} already` : undefined;
  return strip(
    <>
      {say(`Save ${ask.layer.label} as a set named`)}
      <TextInput value={ask.name} onChangeText={(text) => onAsk({ ...ask, name: text })} placeholder="my-set" autoFocus style={{ ...(font(t, { voice: "data", scale: 11 / 12 }) as object), width: 180, paddingVertical: 3, paddingHorizontal: 7, borderWidth: 1, borderColor: String(t.v(problem !== undefined && name !== "" ? "warn" : "line")), borderRadius: 6, backgroundColor: String(t.v("panel")) }} />
      {say("in")}
      <View flexDirection="row" borderRadius={7} borderWidth={1} borderColor={t.v("line") as never} overflow="hidden">
        {host.saveTo.map((each) => (
          <Press key={each.layer} onPress={() => onAsk({ ...ask, where: each.layer })} label={each.label} role="radio" aria-checked={ask.where === each.layer} grow={false} box={({ hovered }) => ({ paddingVertical: 3, paddingHorizontal: 8, backgroundColor: ask.where === each.layer ? t.tint("accent", 12) : hovered ? t.v("panel-2") : "transparent" })}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: ask.where === each.layer ? 600 : 500 }}>{each.label}</Txt>
          </Press>
        ))}
      </View>
      {problem !== undefined && name !== "" ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{problem}</Txt> : null}
    </>,
    <BarButton t={t} words="Save" strong onPress={() => (problem === undefined && ask.where !== undefined ? run(() => host.save(ask.layer, name, ask.where!), `${ask.layer.label} saved as ${name}.`) : undefined)} />,
  );
}
