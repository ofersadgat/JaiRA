import { useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { Pressable, ScrollView, type View as HostView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { InstanceNode, InstanceStatus, StateChild, TaskStatus } from "@jaira/shared/browser";
import { PILL_WORD, pillKindOf } from "@jaira/ui/pill";
import { NO_RUN_OFFERS, restingOf, runColumnsOf, runTileWordsOf, runsByChild } from "@jaira/ui/runBoardModel";
import { PLAIN_SCROLLER, faceOf, scrollbarProps } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Column, GraphPaper, graphPaperWeb } from "../Board";
import { Lift } from "../Lift";
import { ghostAt, ghostOf, useLiftTargets, type Ghost } from "../liftTargets";
import { Pill } from "../Pill";
import { claimed, tileChromeOf } from "../TaskCard";

/**
 * `runViews.tsx`'s `RunBoard`, universal (decision 0015): a composite's board as EXECUTIONS — one column
 * per declared child (`Column`, the task board's own), one card per pass (`RunTile`, on the task card's
 * tile). What it derives is `runBoardModel.ts`'s, shared with the DOM. The rules it adds to the board's:
 *
 *   .board-body     column, flex 1, gap 14, padding 10, scrolls both ways (a run's columns do not wrap)
 *   .columns        row, gap 10, stretch
 *   .column-body    "not reached" for a child nothing reached
 *   .card-head      row, centred, gap 6: the title (data × .96, −0.01em, 600 when selected), the pill,
 *                   and — only when a column holds several passes — `.chip`, the pass number (app
 *                   10/12.5, --dim, 1px --line, radius 999, padding 0 6)
 *   .card-args      data × 10.5/12, --dim, line-height 1.45, 5 above, a line per argument (`.ellip`),
 *                   "+N more" in `.sub` (app 11/12.5 in the args' face)
 *   .card-meta      data × .84, --dim, row, centred, gap 6, 2 above: how long (`.ellip`, flex 1) and
 *                   the status (`.card-status`, flex none)
 *
 * Dragging a card to answer a waiting move (`on_user_event`): the execution the run rests on
 * (`restingOf`) can be picked up where a wait of this run offers a column (`offers`, `runDragOffersOf`);
 * the columns that would take it are dashed in the accent and the one under the pointer filled, as the
 * task board's (`Column`), and the drop answers the wait (`onDrop`). On web the desktop's HTML5 drag
 * (`draggable`, the column's `dragover`/`drop`); on a phone a long press and a pan (`Lift`), the card's
 * picture following the finger.
 */
export function RunBoard({
  declared,
  parent,
  openInstance,
  onSelect,
  onOpen,
  offers = NO_RUN_OFFERS,
  onDrop,
}: {
  declared: readonly StateChild[];
  parent: InstanceNode | undefined;
  openInstance: string | null;
  onSelect: (node: InstanceNode) => void;
  onOpen: (node: InstanceNode) => void;
  /** Column key -> the wait a drop there answers (`runDragOffersOf`); none by default. */
  offers?: ReadonlyMap<string, string>;
  /** A card was dropped on a column that was offering it a place. The caller answers the wait. */
  onDrop?: ((requestId: string) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const byChild = useMemo(() => runsByChild(parent), [parent]);
  const columns = runColumnsOf(declared, byChild);
  const blueprint = look.palette === "blueprint";
  // The card a drag picks up: the execution the run RESTS on (`restingOf`), as `runViews.tsx` has it.
  const resting = useMemo(() => restingOf(parent), [parent]);
  const [dragging, setDragging] = useState(false);
  const draggable = onDrop !== undefined && offers.size > 0;
  // A phone's drag (`Lift`): the columns it may land in, and the picture following the finger.
  const targets = useLiftTargets();
  const root = useRef<HostView>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const [ghost, setGhost] = useState<(Ghost & { node: InstanceNode; index: number; total: number }) | null>(null);
  const dropOf = (key: string) => {
    const requestId = offers.get(key);
    return {
      accepts: requestId !== undefined,
      onDrop: () => {
        setDragging(false);
        if (requestId !== undefined) onDrop?.(requestId);
      },
    };
  };
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      // `.board-body` scrolls both ways: a run's columns are a sequence, and run past the column.
      // `PLAIN_SCROLLER`: painted where it stands in the page, as the desktop's is — what is painted
      // after a scroller shares a layer with its scrollbar, and Chromium draws that layer's text greyscale
      // (the inbox strip under a run); a stacking context of its own is painted last, and left the strip
      // subpixel.
      style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER, ...(isWeb ? { overflowX: "auto" } : {}) } as never}
      contentContainerStyle={{ flexGrow: 1, ...PLAIN_SCROLLER } as never}
      {...(!isWeb ? { horizontal: false } : {})}
    >
      <View
        {...(!isWeb ? { ref: root, onLayout: (e: { nativeEvent: { layout: { width: number } } }) => setRootWidth(e.nativeEvent.layout.width) } : {})}
        flexGrow={1}
        flexDirection="column"
        gap={14}
        padding={10}
        {...((blueprint ? (isWeb ? graphPaperWeb(t) : { position: "relative" }) : {}) as object)}
      >
        {blueprint && !isWeb ? <GraphPaper t={t} /> : null}
        <View flexDirection="row" alignItems="stretch" gap={10}>
          {columns.map((child, index) => {
            const runs = byChild.get(child.key) ?? [];
            const latest = runs[runs.length - 1];
            return (
              <Column
                key={child.key}
                t={t}
                look={look}
                index={index}
                name={child.label ?? child.key}
                seq={index + 1}
                count={runs.length}
                empty="not reached"
                // Double-clicking a COLUMN walks into the newest execution in it; one nothing reached
                // has nowhere to go.
                tip={latest !== undefined ? `double-click to walk into ${child.key}` : `${child.key} was not reached`}
                {...(latest !== undefined ? { onOpen: () => onOpen(latest) } : {})}
                {...(dragging && onDrop !== undefined ? { drop: dropOf(child.key) } : {})}
                {...(!isWeb ? { over: targets.over === child.key, host: targets.host(child.key) } : {})}
              >
                {() =>
                  runs.map((node, i) => {
                    const lifts = draggable && node === resting;
                    const tile = (
                      <RunTile
                        key={node.instanceId}
                        node={node}
                        index={i}
                        total={runs.length}
                        last={i === runs.length - 1}
                        selected={node.instanceId === openInstance}
                        onSelect={() => onSelect(node)}
                        onOpen={() => onOpen(node)}
                        {...(lifts ? { onDragStart: () => setDragging(true), onDragEnd: () => setDragging(false) } : {})}
                      />
                    );
                    if (isWeb || !lifts) return tile;
                    return (
                      <Lift
                        key={node.instanceId}
                        enabled
                        onLift={(host, x, y) => {
                          setDragging(true);
                          targets.measure();
                          ghostOf(host, root.current, rootWidth, x, y, (g) => setGhost({ ...g, node, index: i, total: runs.length }));
                        }}
                        onMove={(x, y) => {
                          targets.move(x, y);
                          setGhost((g) => (g === null ? g : { ...g, ...ghostAt(g, x, y) }));
                        }}
                        onLand={(x, y) => {
                          const key = targets.hit(x, y);
                          targets.clear();
                          setGhost(null);
                          // Only a column that would take it lands it; anywhere else it springs back.
                          if (key !== null && dropOf(key).accepts) dropOf(key).onDrop();
                          else setDragging(false);
                        }}
                        // Held still and let go: the long press it stood in for, which walks in.
                        onHold={() => onOpen(node)}
                        onCancel={() => {
                          targets.clear();
                          setGhost(null);
                          setDragging(false);
                        }}
                      >
                        {tile}
                      </Lift>
                    );
                  })
                }
              </Column>
            );
          })}
        </View>
        {ghost !== null ? (
          // The browser's drag image on a phone: the card itself, see-through, where the finger is.
          <View position="absolute" left={ghost.left} top={ghost.top} width={ghost.width} opacity={0.8} pointerEvents="none" zIndex={10} transform={[{ translateX: ghost.dx }, { translateY: ghost.dy }] as never}>
            <RunTile node={ghost.node} index={ghost.index} total={ghost.total} last selected={false} onSelect={() => undefined} onOpen={() => undefined} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

/**
 * `RunTile`: one execution, on the task card's tile (`tileChromeOf`) — its name and pill, the pass
 * number when there are several, the arguments it was called with, how long it took and its status.
 */
function RunTile({
  node,
  index,
  total,
  last,
  selected,
  onSelect,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  node: InstanceNode;
  index: number;
  total: number;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** Present only where a wait offered this run a move: the tile can be picked up (HTML5 drag on web). */
  onDragStart?: (() => void) | undefined;
  onDragEnd?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const words = runTileWordsOf(node);
  const pill = pillKindOf(node.status as TaskStatus | InstanceStatus | undefined);
  const { wash, ground, ring, hoverGround, hoverRing, radius, below } = tileChromeOf(t, look, { pill, selected, last, inTray: false });
  // The data voice at a factor of --size-data, line-height 1.5 as the body sets it (as `TaskCard`'s).
  const line = (factor: number, lh = 1.5, weight = 400): object => ({
    ...faceOf(t, "data", weight, t.scaled("size-data", factor)),
    fontSize: t.scaled("size-data", factor),
    lineHeight: isWeb ? String(lh) : Number(t.scaled("size-data", factor)) * lh,
  });
  const oneLine = isWeb ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : { numberOfLines: 1, ellipsizeMode: "tail" };
  const web = isWeb
    ? {
        onClick: (e: ReactMouseEvent) => {
          claimed.add(e.nativeEvent);
          onSelect();
        },
        onDoubleClick: onOpen,
        onMouseDown: (e: ReactMouseEvent) => (e.shiftKey ? e.preventDefault() : undefined),
        title: words.tip,
        // `.card-draggable`: grab, where a wait offered the move.
        cursor: onDragStart !== undefined ? "grab" : "pointer",
        userSelect: "none",
        ...(onDragStart !== undefined
          ? {
              draggable: true,
              onDragStart: (e: DragEvent) => {
                // As the DOM's: Firefox refuses a drag with nothing on the transfer.
                e.dataTransfer?.setData("text/plain", node.instanceId);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                onDragStart();
              },
              ...(onDragEnd !== undefined ? { onDragEnd } : {}),
            }
          : {}),
      }
    : {};
  const drawn = (
    <View
      {...(web as object)}
      position="relative"
      backgroundColor={ground as never}
      {...((ring !== undefined ? { boxShadow: ring } : {}) as object)}
      borderRadius={radius as never}
      paddingTop={7}
      paddingRight={9}
      paddingBottom={6}
      paddingLeft={9}
      marginBottom={below}
      hoverStyle={{ backgroundColor: hoverGround as never, ...((hoverRing !== undefined ? { boxShadow: hoverRing } : {}) as object) }}
    >
      <View flexDirection="row" alignItems="center" gap={6}>
        <Text
          {...(line(0.96, 1.5, selected ? 600 : 400) as object)}
          {...(oneLine as object)}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          {...({ letterSpacing: isWeb ? "-0.01em" : Number(t.scaled("size-data", 0.96)) * -0.01 } as object)}
          fontWeight={selected ? "600" : "400"}
          color={(wash === "success" ? t.v("dim") : t.v("text")) as never}
        >
          {words.title}
        </Text>
        {pill !== null ? <Pill kind={pill} word={PILL_WORD[pill]} title={node.status} /> : null}
        {total > 1 ? (
          <View flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={999} paddingHorizontal={6}>
            <Text fontFamily={t.v("font-app") as never} fontSize={t.scaled("size-app", 10 / 12.5) as never} lineHeight={(isWeb ? "1.5" : Number(t.scaled("size-app", 10 / 12.5)) * 1.5) as never} color={t.v("dim") as never} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}>
              {index + 1}
            </Text>
          </View>
        ) : null}
      </View>
      {words.args.length > 0 ? (
        <View flexDirection="column" minWidth={0} marginTop={5}>
          {words.args.map((param) => (
            <Text key={param.name} {...(line(10.5 / 12, 1.45) as object)} {...(oneLine as object)} color={t.v("dim") as never}>
              {param.name} {param.preview}
            </Text>
          ))}
          {words.more > 0 ? (
            <Text fontFamily={t.v("font-data") as never} fontSize={t.scaled("size-app", 11 / 12.5) as never} lineHeight={(isWeb ? "1.45" : Number(t.scaled("size-app", 11 / 12.5)) * 1.45) as never} color={t.v("dim") as never}>
              +{words.more} more
            </Text>
          ) : null}
        </View>
      ) : null}
      <View flexDirection="row" alignItems="center" gap={6} marginTop={2} overflow="hidden">
        <Text {...(line(0.84) as object)} {...(oneLine as object)} color={t.v("dim") as never} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
          {words.when}
        </Text>
        <Text {...(line(0.84) as object)} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)} color={t.v("dim") as never} flexShrink={0}>
          {words.status}
        </Text>
      </View>
    </View>
  );
  if (isWeb) return drawn;
  // A phone: a tap marks it, a long press walks in (the desktop's double-click).
  return (
    <Pressable onPress={onSelect} onLongPress={onOpen}>
      {drawn}
    </Pressable>
  );
}
