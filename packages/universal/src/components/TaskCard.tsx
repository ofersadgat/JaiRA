import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { Pressable } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { chipTip, endedLabel, holdingLabelOf, originLineOf, waitingKindOf } from "@jaira/ui/boardModel";
import { PILL_WORD, pillKindOf } from "@jaira/ui/pill";
import type { CardProps } from "@jaira/ui/slots";
import { taskNameNote, taskNameOf, taskNamePending } from "@jaira/ui/taskName";
import type { InstanceStatus, TaskStatus } from "@jaira/shared/browser";
import { edge } from "../primitives";
import { useLook, useTokens } from "../tokens";
import { CardDom } from "./domFallback";
import { MachineChip } from "./MachineChip";
import { NextChips } from "./NextChips";
import { Pill } from "./Pill";

/**
 * `board.tsx`'s `Card` (on its `Tile`), universal (decision 0015). Read that one for what a card says;
 * this one only has to look the same, and every rule below is one `styles.css` applies to a card,
 * with the specificity contest it wins or loses worked out by hand — a copy has no cascade to do it:
 *
 *   .card                                  ghost ground, radius --control-radius-sm, padding 7 9 6, 4 below
 *   .card:last-child                       0 below — LOSES to any palette's margin (0,2,0 < 0,3,0)
 *   .card:hover / .card-selected           ghost-selected / --tint-accent
 *   :root[data-palette] .card(:hover|-selected)   the tile: its ground, edge ring and shadow; 6 below
 *   :root[data-palette="contrast"|pastel|blueprint] .card   radius 2 | 11 | 1; contrast 8 below
 *   :root[data-wash] .card[data-pill=…]    the status wash, which beats hover and selection's ground;
 *                                          selection becomes a 2px ring
 *   .card.card-child                       14 in, a 2px rule on the left
 *   .card-draggable                        grab cursor; HTML5 drag on web (native drags in v2)
 *   .card.is-archived                      0.62 opacity, back to 1 when hovered or selected; the pill
 *                                          is how it finished, the meta line when it was archived
 *   .mchip in .card-meta                   where it runs, first on the meta line (`MachineChip`)
 *   .card-head / .card-title / .card-meta  the rows; the title is the data voice, 600 when selected
 *   (block layout)                         .card-next's 1px bottom margin collapses into .card-meta's 2px
 *                                          top; a flex column would add them, so the copy collapses them
 *
 * Not copied yet, and drawn by the DOM card on web instead: a card with an undo link (a moment after a
 * drop, so never in v1's read-only reach), and one with an origin line, which is the next thing this
 * copy should learn.
 */
/**
 * The clicks a card (or something on it) took, by their DOM event: a column's own click, which in the DOM
 * reads `closest(".card")` off the target, reads this instead — the copies have no classes.
 */
export const claimed = new WeakSet<object>();

export function TaskCard(props: CardProps & { inTray?: boolean }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const { card, selected, onSelect, onDrill, onMenu, onDragStart, onDragEnd, onUndo, onMove, child = false, last = false, inTray = false } = props;
  const uncovered = onUndo !== undefined || originLineOf(card) !== undefined;
  if (uncovered && CardDom !== null) {
    const { inTray: _tray, ...dom } = props;
    return <CardDom {...dom} />;
  }

  // An ARCHIVED card wears the pill of how it finished, as the DOM card does.
  const status = card.archived !== undefined ? card.archived.from : (card.activeStatus ?? card.status);
  const archived = card.archived !== undefined;
  const pill = pillKindOf(status as TaskStatus | InstanceStatus | undefined);
  const { wash, ground, ring, hoverGround, hoverRing, radius, below } = tileChromeOf(t, look, { pill, selected, last, inTray });

  // --- the words ---
  const pending = taskNamePending(card);
  const fallback = card.heading?.error !== undefined;
  const note = taskNameNote(card);
  const where =
    card.endedAt !== undefined && card.archived !== undefined
      ? `archived ${endedLabel(card.archived.at)}`
      : card.under !== undefined
        ? `adopted · ${card.workflow}`
        : (card.activeStateId ?? card.status);
  const whereTitle = card.endedAt !== undefined && card.archived !== undefined ? `archived ${new Date(card.archived.at).toLocaleString()}` : undefined;
  const far =
    card.endedAt !== undefined
      ? { text: endedLabel(card.endedAt), title: new Date(card.endedAt).toLocaleString() }
      : waitingKindOf(card) !== undefined
        ? { text: waitingKindOf(card)!, title: holdingLabelOf(card) }
        : undefined;
  const tip =
    card.endedAt !== undefined
      ? `${card.status} · ${new Date(card.endedAt).toLocaleString()}`
      : onDrill
        ? "double-click to open this run"
        : (card.activeStateId ?? card.status);

  // --- type: the data voice, line-height 1.5 as the body sets it and every row inherits ---
  const line = (factor: number): object => ({
    fontFamily: t.v("font-data"),
    fontSize: t.scaled("size-data", factor),
    lineHeight: isWeb ? "1.5" : Number(t.scaled("size-data", factor)) * 1.5,
  });
  const oneLine = isWeb ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {};
  const clip = isWeb ? {} : { numberOfLines: 1, ellipsizeMode: "tail" };

  const web = isWeb
    ? {
        onClick: (e: ReactMouseEvent) => {
          claimed.add(e.nativeEvent);
          onSelect(e);
        },
        ...(onDrill !== undefined ? { onDoubleClick: onDrill } : {}),
        ...(onMenu !== undefined ? { onContextMenu: onMenu } : {}),
        onMouseDown: (e: ReactMouseEvent) => (e.shiftKey ? e.preventDefault() : undefined),
        title: tip,
        cursor: onDragStart !== undefined ? "grab" : "pointer",
        userSelect: "none",
        ...(onDragStart !== undefined
          ? {
              draggable: true,
              onDragStart: (e: DragEvent) => {
                // As the DOM card does: Firefox refuses a drag with nothing on the transfer.
                e.dataTransfer?.setData("text/plain", card.taskId);
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
      {...(inTray ? { width: 210 } : {})}
      {...((child
        ? { marginLeft: 14, ...edge(t, { left: 2 }, t.mix(t.v("accent"), 45, t.v("line"))) }
        : {}) as object)}
      {...((archived ? { opacity: selected ? 1 : 0.62 } : {}) as object)}
      hoverStyle={{ backgroundColor: hoverGround as never, ...((hoverRing !== undefined ? { boxShadow: hoverRing } : {}) as object), ...(archived ? { opacity: 1 } : {}) }}
    >
      <View flexDirection="row" alignItems="center" gap={6}>
        <Text
          {...(line(0.96) as object)}
          {...(oneLine as object)}
          {...(clip as object)}
          {...((isWeb && note !== undefined ? { title: note } : {}) as object)}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          {...({ letterSpacing: isWeb ? "-0.01em" : Number(t.scaled("size-data", 0.96)) * -0.01 } as object)}
          fontWeight={selected ? "600" : "400"}
          color={(wash === "success" || pending ? t.v("dim") : t.v("text")) as never}
          {...((pending ? { fontStyle: "italic" } : {}) as object)}
          {...((fallback
            ? { textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: t.v("dim"), ...(isWeb ? { textUnderlineOffset: "3px" } : {}) }
            : {}) as object)}
        >
          {taskNameOf(card)}
        </Text>
        {pill !== null ? <Pill kind={pill} word={PILL_WORD[pill]} {...(status !== undefined ? { title: status } : {})} /> : null}
      </View>
      {onMove !== undefined && (card.next ?? []).length > 0 ? <NextChips moves={card.next!} onMove={onMove} tip={chipTip} collapsesInto={2} /> : null}
      <View flexDirection="row" alignItems="center" gap={6} marginTop={2} overflow="hidden">
        {/* Where it runs, first: a project of several workspaces (the machines decision, §4). */}
        {card.where !== undefined ? (
          <MachineChip label={card.where.label} state={card.where.state} {...(card.where.title !== undefined ? { title: card.where.title } : {})} voice={String(t.v("font-data"))} />
        ) : null}
        <Text
          {...(line(0.84) as object)}
          {...(oneLine as object)}
          {...(clip as object)}
          {...((isWeb && whereTitle !== undefined ? { title: whereTitle } : {}) as object)}
          color={t.v("dim") as never}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
        >
          {where}
        </Text>
        {far !== undefined ? (
          <Text
            {...(line(0.84) as object)}
            {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}
            {...((isWeb && far.title !== undefined ? { title: far.title } : {}) as object)}
            color={t.v("dim") as never}
            flexShrink={0}
          >
            {far.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
  if (isWeb) return drawn;
  // A phone: React Native's Pressable, since Tamagui's `onPress` never fires on Android. A tap selects,
  // a long press opens the run (the desktop's double-click).
  return (
    <Pressable onPress={() => onSelect(undefined as never)} {...(onDrill !== undefined ? { onLongPress: onDrill } : {})}>
      {drawn}
    </Pressable>
  );
}

/**
 * A tile's chrome (`board.tsx`'s `Tile`): its ground, ring and shadow, their hovered forms, its radius
 * and the room under it, in the order the cascade decides them (see the rules above). Shared by the task
 * card and the run board's execution card (`components/run/RunBoard.tsx`), which are the same tile.
 */
export function tileChromeOf(
  t: ReturnType<typeof useTokens>,
  look: ReturnType<typeof useLook>,
  { pill, selected, last, inTray }: { pill: ReturnType<typeof pillKindOf>; selected: boolean; last: boolean; inTray: boolean },
): { wash: ReturnType<typeof pillKindOf>; ground: string | number; ring: string | undefined; hoverGround: string | number | undefined; hoverRing: string | undefined; radius: string | number; below: number } {
  const named = look.palette !== "classic";
  const wash = look.wash && pill !== null ? pill : null;

  // --- the ground, ring and shadow, in the order the cascade decides them ---
  const tile = t.v("tile");
  let ground: string | number = named ? tile : t.v("fill-ghost-hover");
  let ring: string | undefined = named ? `0 0 0 1px ${t.v("tile-edge")}, ${t.v("tile-shadow")}` : undefined;
  let hoverGround: string | number | undefined = named ? tile : t.v("fill-ghost-selected");
  let hoverRing: string | undefined = named ? `0 0 0 1px ${t.v("rule")}, ${t.v("tile-shadow-hi")}` : undefined;
  if (selected) {
    ground = named ? t.mix(t.v("accent"), 7, tile) : t.v("tint-accent");
    ring = named ? `0 0 0 1.5px ${t.v("accent")}, ${t.v("tile-shadow")}` : undefined;
    hoverGround = ground;
    hoverRing = ring;
  }
  if (wash !== null) {
    const under = named ? tile : t.v("panel");
    const edge = (name: string, pct: number): string => `0 0 0 1px ${t.mix(t.v(name), pct, "transparent")}`;
    [ground, ring] =
      wash === "running"
        ? [t.mix(t.v("accent"), 11, under), edge("accent", 35)]
        : wash === "waiting"
          ? [t.mix(t.v("warn"), 14, under), edge("warn", 40)]
          : wash === "error"
            ? [t.mix(t.v("bad"), 10, under), edge("bad", 35)]
            : wash === "success"
              ? ["transparent", `0 0 0 1px ${t.v("line")}`]
              : [ground, ring];
    if (selected) ring = `0 0 0 2px ${t.v("accent")}`;
    // The wash rules come later at equal specificity, so hovering changes nothing.
    hoverGround = ground;
    hoverRing = ring;
  }
  const radius =
    look.palette === "contrast" ? 2 : look.palette === "pastel" || look.palette === "pastel-rail" ? 11 : look.palette === "blueprint" ? 1 : t.v("control-radius-sm");
  // `.tray-cards .card` (0,2,0): 210 wide, no margin — which every palette's margin (0,3,0) beats.
  const below = look.palette === "contrast" ? 8 : named ? 6 : last || inTray ? 0 : 4;

  return { wash, ground, ring, hoverGround, hoverRing, radius, below };
}
