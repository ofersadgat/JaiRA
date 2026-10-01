import { useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { InstanceNode } from "@jaira/shared/browser";
import { nameOf } from "@jaira/ui/rail";
import { keyOfNode, stepsIn, toneOf, useRunIndexModel, type RunIndexFit } from "@jaira/ui/runIndexModel";
import { metaOf } from "@jaira/ui/sessionRows";
import type { DisplayItem } from "@jaira/ui/stepCompaction";
import { Press, Txt, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Icon } from "./Icon";
import { RailedRows, cssColour } from "./Rail";
import { PanelEmpty } from "./PanelViews";

/**
 * The run's instances on the conversation's own rail, one row per state — the letterheads stacked. Its
 * rows, folds, loops and fitting are `runIndexModel.ts`'s (`useRunIndexModel`). How it looks:
 *
 *   the rail            a cap of 30, no measure
 *   a row               row, centred, gap 2, full width, a 2px transparent edge on the left (a loop's
 *                       pass: --accent 30%), radius 5; data 11/12, --dim
 *   its chevron         15 square, centred, radius 3, --dim (hover --text); open: turned 90°; the
 *                       glyph 11. A leaf keeps the slot, hidden
 *   its bookmark        flex 1, row, centred, gap 7, padding 3 6, radius 4, clipped; hover
 *                       --fill-ghost-hover and --text
 *   the dot             6 round, --dim
 *   the name            data 12/12, 600, --text; superseded: struck through at 0.5 (the row at 0.72)
 *   why it failed       app 11/12.5, --bad, ellipsed, flex 1
 *   the steps count     8 before, padding 1 6, radius 3, --panel-2, --dim, 9.5px, 0.05em, upper
 *   the meta            data 10/12, tabular, 0.85, pushed right, 10 before, ellipsed, gives way first
 *   a toned row         the letterhead's tones: accent --accent 12% into --panel, the name --accent;
 *                       amber --warn 14%, an inset 1px --warn 30% into --line, the name --warn; red
 *                       --bad 11%, the name --bad
 *   the reader's row    --accent 15% into --panel, an inset 1.5px --accent 42%; the name --accent. On a
 *                       toned row the tone keeps the fill and the ring is --accent 62%
 *   a loop's tag        pill: padding 2 8, 1px --accent 32% into --line, --accent 9%, --accent; data
 *                       9.5px 700, 0.06em, upper; ↻ at 11
 *   a folded loop       row, centred, gap 7: the cycle's swatches (3 × 11, radius 1, gap 2) and names
 *
 * A row's right-click (a long press on a phone) is its menu — go to it, rewind to before it, fork there
 * (`onCut`) — and the gutter folds a lane pressed on its knot, or goes to a state with nothing under it
 * (`onPick`; see `Rail.tsx`).
 */
export function RunIndex({
  instances,
  here,
  asking,
  onGoTo,
  onCut,
  fit,
}: {
  instances: readonly InstanceNode[];
  here?: string | undefined;
  asking?: string | undefined;
  onGoTo?: ((node: InstanceNode) => void) | undefined;
  /** The two verbs of a cut (`cut.ts`), on a row's menu. Absent ⇒ a row has no menu. */
  onCut?: { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined;
  fit?: RunIndexFit | undefined;
}): JSX.Element {
  const t = useTokens();
  const { steps, rows, palette, shutLanes, toggleFold, toggleLoop, foldable, onShut, mark, isHere, fitRows, gapOf, expand, byKey, now } = useRunIndexModel({ instances, fit, here });
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const goTop = (key: string): void => {
    const node = byKey.get(key);
    if (node !== undefined) onGoTo?.(node);
  };
  /** A lane with nothing under it cannot fold, so its mark does what its label does. */
  const onPick = goTop;
  /** A row's menu: go to it, and — not on the root, which nothing rewinds to — the cut's two verbs. */
  const menuOf = (node: InstanceNode, name: string, x: number, y: number): void => {
    if (onCut === undefined || node.parentInstanceId === undefined) return;
    setMenu({
      x,
      y,
      items: [
        ...(onGoTo !== undefined ? [{ label: `Go to ${name} in the conversation`, onSelect: () => onGoTo(node) }] : []),
        { label: `Rewind to before ${name}`, note: "deletes it and everything after", separator: onGoTo !== undefined, onSelect: () => onCut.rewind(node) },
        { label: `Fork before ${name}`, note: "a new task from here", onSelect: () => onCut.fork(node) },
      ],
    });
  };

  const row = (index: number, folded: boolean): JSX.Element | null => {
    const what = rows[index];
    if (what === undefined) return null;
    if (what.kind === "loop") {
      return (
        <View flexDirection="row" alignItems="center" gap={7} width="100%" minWidth={0}>
          <Press onPress={() => toggleLoop(what.key)} title={`expand ${what.times} passes`} flex={1} minWidth={0} flexDirection="row" alignItems="center" gap={7} paddingVertical={3} paddingHorizontal={6} borderRadius={4} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
            <View flexDirection="row" gap={2} flexShrink={0}>
              {what.members.slice(0, what.period).map((member, i) => (
                <View key={`${keyOfNode(member)}:${i}`} width={3} height={11} borderRadius={1} backgroundColor={cssColour(t, palette.get(nameOf(member)) ?? "var(--rule)") as never} />
              ))}
            </View>
            <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600 }} ellip flex={1} minWidth={0}>
              {what.members
                .slice(0, what.period)
                .map((member) => nameOf(member))
                .join(" · ")}
            </Txt>
          </Press>
          <LoopTag times={what.times} onToggle={() => toggleLoop(what.key)} t={t} />
        </View>
      );
    }
    const node = what.node;
    const tone = toneOf(node, asking);
    const held = stepsIn(node);
    const name = nameOf(node);
    const meta = metaOf(node, now);
    const on = here === keyOfNode(node);
    const toneInk = tone === "accent" ? "accent" : tone === "amber" ? "warn" : tone === "red" ? "bad" : undefined;
    const fill = tone === "accent" ? t.mix(t.v("accent"), 12, t.v("panel")) : tone === "amber" ? t.mix(t.v("warn"), 14, t.v("panel")) : tone === "red" ? t.mix(t.v("bad"), 11, t.v("panel")) : undefined;
    // A folded state is a TILE: --panel, a --line ring and a soft shadow, radius 6. It beats the tone and
    // the here-chip; only a toned row the reader is on keeps its fill and ring over it.
    const heavy = on && fill !== undefined;
    const ground = folded && !heavy ? t.v("panel") : (fill ?? (on ? t.mix(t.v("accent"), 15, t.v("panel")) : undefined));
    const ring = folded && !heavy ? `0px 0px 0px 1px ${String(t.v("line"))}, 0px 1px 2px rgba(0, 0, 0, 0.06)` : on ? `inset 0px 0px 0px 1.5px ${t.mix(t.v("accent"), fill !== undefined ? 62 : 42, "transparent")}` : tone === "amber" ? `inset 0px 0px 0px 1px ${t.mix(t.v("warn"), 30, t.v("line"))}` : undefined;
    const inside = (hovered: boolean): ReactNode => {
      const ink = hovered && onGoTo !== undefined ? "text" : "dim";
      return (
        <>
          <View width={6} height={6} borderRadius={3} flexShrink={0} backgroundColor={t.v("dim") as never} />
          <Txt spec={{ voice: "data", scale: 1, weight: 600, color: toneInk ?? (on ? "accent" : "text") }} flexShrink={0} {...(node.superseded ? { textDecorationLine: "line-through", opacity: 0.5 } : {})}>
            {name}
          </Txt>
          {node.operation?.status === "failed" && node.operation.reason !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} ellip flex={1} minWidth={0}>
              {node.operation.reason}
            </Txt>
          ) : null}
          {folded ? (
            <View flexShrink={0} marginLeft={8} paddingVertical={1} paddingHorizontal={6} borderRadius={3} backgroundColor={t.v("panel-2") as never}>
              <Txt spec={{ voice: "data", scale: 1, upper: true, color: "dim" }} fontSize={9.5} letterSpacing={9.5 * 0.05} lineHeight={t.replayed ? 14.25 : undefined} numberOfLines={1}>
                {held} step{held === 1 ? "" : "s"}
              </Txt>
            </View>
          ) : null}
          {meta !== "" ? (
            <Txt spec={{ voice: "data", scale: 10 / 12, tabular: true, color: ink }} ellip flexShrink={1} minWidth={0} marginLeft="auto" paddingLeft={10} opacity={0.85}>
              {meta}
            </Txt>
          ) : null}
        </>
      );
    };
    const go = { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 3, paddingHorizontal: 6, borderRadius: folded ? 6 : 4, overflow: "hidden" } as const;
    const paint = (hovered: boolean): Record<string, unknown> => ({
      backgroundColor: ground ?? (hovered && onGoTo !== undefined ? t.v("fill-ghost-hover") : "transparent"),
      ...(ring !== undefined ? { boxShadow: ring } : {}),
    });
    const cuttable = onCut !== undefined && node.parentInstanceId !== undefined;
    return (
      <View
        {...((cuttable && isWeb
          ? {
              onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
                e.preventDefault();
                menuOf(node, name, e.clientX, e.clientY);
              },
            }
          : {}) as object)}
        flexDirection="row"
        alignItems="center"
        gap={2}
        width="100%"
        minWidth={0}
        borderRadius={5}
        {...(what.loop !== undefined ? { borderLeftWidth: 2, borderStyle: "solid", borderColor: t.mix(t.v("accent"), 30, "transparent") } : { borderLeftWidth: 2, borderStyle: "solid", borderColor: "transparent" })}
        {...({ borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 } as object)}
        {...(node.superseded ? { opacity: 0.72 } : {})}
      >
        {what.lane !== undefined ? (
          <Press onPress={() => toggleFold(what.lane!, false)} label={`${folded ? "Expand" : "Collapse"} ${name}`} width={15} height={15} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={3}>
            {({ hovered }) => (
              <View transform={folded ? [] : [{ rotate: "90deg" }]}>
                <Icon name="chevron" size={Number(t.scaled("size-data", 11 / 12)) || 11} color={String(t.v(hovered ? "text" : "dim"))} />
              </View>
            )}
          </Press>
        ) : (
          // The slot is kept so every name in the column starts at the same x. A leaf has no fold.
          <View width={15} height={15} flexShrink={0} />
        )}
        {onGoTo === undefined ? (
          <View {...go} {...(paint(false) as object)}>
            {inside(false)}
          </View>
        ) : (
          <Press
            onPress={() => onGoTo(node)}
            // A phone has no right button: a long press opens the row's menu where the finger is.
            {...(cuttable && !isWeb ? { onLongPress: (e: GestureResponderEvent) => menuOf(node, name, e.nativeEvent.pageX, e.nativeEvent.pageY) } : {})}
            title={`go to ${name} in the conversation`}
            {...go}
            box={({ hovered }) => paint(hovered)}
          >
            {({ hovered }) => inside(hovered)}
          </Press>
        )}
        {what.loop?.head === true ? <LoopTag times={what.loop.times} onToggle={() => toggleLoop(what.loop!.key)} t={t} /> : null}
      </View>
    );
  };

  const small: FontSpec = { voice: "data", scale: 11 / 12, color: "dim" };
  const renderGap = (item: Extract<DisplayItem, { kind: "gap" }>): JSX.Element => {
    const { count, named, more } = gapOf(item);
    return (
      <View flexDirection="row" alignItems="center" gap={6} width="100%" minWidth={0}>
        <View width={15} height={15} flexShrink={0} />
        <Press onPress={() => expand(item.key)} title={`show the ${count} step${count === 1 ? "" : "s"} here`} flexShrink={0} flexDirection="row" alignItems="baseline">
          <Txt spec={small}>⋯ </Txt>
          <Txt spec={small}>
            {count} step{count === 1 ? "" : "s"}
          </Txt>
        </Press>
        <View flexDirection="row" alignItems="baseline" minWidth={0} flexShrink={1} overflow="hidden">
          {named.map((one, i) => (
            <View key={one.key} flexDirection="row" alignItems="baseline">
              {i > 0 ? <Txt spec={small}> · </Txt> : null}
              <Press onPress={() => goTop(one.goTo)} disabled={onGoTo === undefined} title={`go to the top of ${one.stateId}`}>
                <Txt spec={small}>{one.stateId}</Txt>
              </Press>
            </View>
          ))}
          {more > 0 ? <Txt spec={small}> +{more}</Txt> : null}
        </View>
      </View>
    );
  };
  const renderCrumb = (item: Extract<DisplayItem, { kind: "crumb" }>): JSX.Element => {
    const deepest = byKey.get(item.lanes[item.lanes.length - 1]?.key ?? "");
    const meta = deepest === undefined ? "" : metaOf(deepest, now);
    return (
      <View flexDirection="row" alignItems="center" gap={6} width="100%" minWidth={0}>
        <View width={15} height={15} flexShrink={0} />
        <View flexDirection="row" alignItems="baseline" minWidth={0} flexShrink={1} overflow="hidden">
          {item.lanes.map((lane, i) => (
            <View key={lane.key} flexDirection="row" alignItems="baseline">
              {i > 0 ? <Txt spec={small}> › </Txt> : null}
              <Press onPress={() => goTop(lane.key)} disabled={onGoTo === undefined} title={`go to the top of ${lane.stateId}`}>
                <Txt spec={{ ...small, ...(i === item.lanes.length - 1 ? { weight: 600, color: "text" } : {}) }}>{lane.stateId}</Txt>
              </Press>
            </View>
          ))}
        </View>
        {meta !== "" ? (
          <Txt spec={{ voice: "data", scale: 10 / 12, tabular: true, color: "dim" }} ellip marginLeft="auto" paddingLeft={10} opacity={0.85}>
            {meta}
          </Txt>
        ) : null}
      </View>
    );
  };

  if (instances.length === 0) return <PanelEmpty>No run yet.</PanelEmpty>;
  return (
    <>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      <RailedRows
        steps={steps}
        index
        cap={30}
        renderStep={(index) => row(index, false)}
        renderRolled={(lane) => {
          const at = steps.findIndex((step) => step.key === lane.key);
          return at < 0 ? null : row(at, true);
        }}
        mark={mark}
        here={isHere}
        palette={palette}
        shut={shutLanes}
        onShut={onShut}
        foldable={foldable}
        onPick={onPick}
        compact={fitRows}
        renderGap={renderGap}
        renderCrumb={renderCrumb}
      />
    </>
  );
}

/** A loop's tag: a cycle's passes, and the control that folds them into one row. */
function LoopTag({ times, onToggle, t }: { times: number; onToggle: () => void; t: Tokens }): JSX.Element {
  const words: FontSpec = { voice: "data", scale: 1, weight: 700, upper: true, color: "accent" };
  return (
    <Press
      onPress={onToggle}
      title={`${times} passes of this cycle — fold them into one row`}
      flexShrink={0}
      marginLeft={2}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={2}
      paddingHorizontal={8}
      borderRadius={999}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("accent"), 32, t.v("line")) as never}
      box={({ hovered }) => ({ backgroundColor: t.mix(t.v("accent"), hovered ? 16 : 9, "transparent") })}
    >
      <Txt spec={{ ...words, weight: 400 }} fontSize={11} lineHeight={t.replayed ? 11 : undefined}>
        ↻
      </Txt>
      <Txt spec={words} fontSize={9.5} letterSpacing={9.5 * 0.06} lineHeight={t.replayed ? 14.25 : undefined} numberOfLines={1}>
        {times} passes
      </Txt>
    </Press>
  );
}
