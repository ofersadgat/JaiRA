import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { Animated, PanResponder, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { InstanceNode } from "@jaira/shared/browser";
import { RAIL_OPEN, RAIL_WIDTH, ancestorsOf, railAt, railPull, scrubRow } from "@jaira/ui/phoneModel";
import { nameOf } from "@jaira/ui/rail";
import type { IndexRow } from "@jaira/ui/runIndexModel";
import { metaOf } from "@jaira/ui/sessionRows";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { RunIndex } from "./RunIndex";

/**
 * A phone's Steps (decision 0015, amended 2026-10-04): the run's index (`RunIndex`) at the right edge of
 * its conversation, as bookmarks into it — the index's own rail, one row per state, its lanes squeezed
 * together to fit a strip (a child's line over its parent's: `rail.ts`' `centresFor`, `squeeze`).
 *
 * - **a tap** on a knot or a line lands the conversation where that state was entered, as a bookmark in
 *   the desktop's index does;
 * - **a drag along it** lands it on the state under the finger as the finger moves, and a label beside
 *   the finger names the state, its path and its time;
 * - **a pull to the left** widens it into the index itself: the lanes spread to the index's spacing and
 *   the rows come in beside them at the same heights, so the pull is one movement that follows the
 *   finger (`phoneModel.ts`' `railAt`). Let go past halfway it opens; a row pressed lands and folds it
 *   back, as does a pull to the right or a press on the conversation.
 *
 * How it looks:
 *
 *   the strip      30 wide, the conversation's height, --panel at 92% over the page, a --line on its left
 *   pulled out     up to 300, --panel, a shadow to the left; the conversation under --scrim at the pull
 *   the label      a float to the left of the finger: --text ground, --bg ink, radius 10, padding 8 12;
 *                  the path data 11.5, the name data 14 bold, the time app 11.5 — one line each
 */
export function StepsRail({
  instances,
  here,
  asking,
  onGoTo,
}: {
  instances: readonly InstanceNode[];
  here?: string | undefined;
  asking?: string | undefined;
  onGoTo: (node: InstanceNode) => void;
}): JSX.Element {
  const t = useTokens();
  const [pull, setPullState] = useState(0);
  const pullNow = useRef(0);
  const setPull = (next: number): void => {
    pullNow.current = next;
    setPullState(next);
  };
  const [scrub, setScrub] = useState<{ y: number; node: InstanceNode } | null>(null);
  const rows = useRef<readonly IndexRow[]>([]);
  const onRows = useCallback((next: readonly IndexRow[]) => {
    rows.current = next;
  }, []);
  const contentHeight = useRef(0);
  const box = useRef<RNView>(null);
  const boxTop = useRef(0);
  const byId = useMemo(() => new Map(instances.map((n) => [n.instanceId, n])), [instances]);
  const live = useRef({ onGoTo, byId });
  live.current = { onGoTo, byId };

  const nodeOfRow = (i: number): InstanceNode | undefined => {
    const row = rows.current[i];
    return row === undefined ? undefined : row.kind === "state" ? row.node : row.members[0];
  };
  const responder = useMemo(() => {
    let mode: "pull" | "scrub" | undefined;
    let from = 0;
    let last = -1;
    const scrubAt = (pageY: number): void => {
      const y = pageY - boxTop.current;
      const i = scrubRow(y - 8, contentHeight.current, rows.current.length);
      const node = nodeOfRow(i);
      if (node === undefined) return;
      setScrub({ y, node });
      if (i !== last) {
        last = i;
        live.current.onGoTo(node);
      }
    };
    return PanResponder.create({
      // Taps are the index's own (a knot, a row); a drag is the rail's — taken from under them.
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
      onPanResponderGrant: (e) => {
        mode = undefined;
        last = -1;
        from = pullNow.current;
        const pageY = e.nativeEvent.pageY;
        box.current?.measureInWindow((_x, y) => {
          boxTop.current = y;
          if (mode === "scrub") scrubAt(pageY);
        });
      },
      onPanResponderMove: (e, g) => {
        if (mode === undefined) mode = Math.abs(g.dx) > Math.abs(g.dy) ? "pull" : "scrub";
        if (mode === "pull") setPull(railPull(from, g.dx));
        else scrubAt(e.nativeEvent.pageY);
      },
      onPanResponderRelease: () => {
        if (mode === "pull") setPull(pullNow.current > 0.5 ? 1 : 0);
        setScrub(null);
      },
      onPanResponderTerminate: () => {
        if (mode === "pull") setPull(pullNow.current > 0.5 ? 1 : 0);
        setScrub(null);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { width, squeeze, fade } = railAt(pull);
  const path = scrub === null ? [] : ancestorsOf(scrub.node, byId, nameOf);
  const meta = scrub === null ? "" : metaOf(scrub.node, Date.now());
  return (
    <RNView pointerEvents="box-none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
      {pull > 0 ? (
        <Animated.View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: Math.min(1, pull) * 0.6 }}>
          <Press onPress={() => setPull(0)} label="Fold the steps" position="absolute" top={0} left={0} right={0} bottom={0} box={() => ({ backgroundColor: t.v("scrim") })} />
        </Animated.View>
      ) : null}
      <RNView
        ref={box}
        {...responder.panHandlers}
        accessibilityLabel="Steps"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width,
          overflow: "hidden",
          backgroundColor: (pull > 0 ? t.v("panel") : t.mix(t.v("panel"), 92, "transparent")) as string,
          ...(pull > 0 ? { shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: -4, height: 0 }, elevation: 10, ...(isWeb ? { boxShadow: "-10px 0 26px rgba(18, 21, 48, 0.18)" } : {}) } : {}),
          ...(edge(t, { left: 1 }) as object),
        }}
      >
        <View width={RAIL_OPEN} paddingTop={8} onLayout={(e: { nativeEvent: { layout: { height: number } } }) => (contentHeight.current = e.nativeEvent.layout.height - 8)}>
          <RunIndex
            instances={instances}
            {...(here !== undefined ? { here } : {})}
            {...(asking !== undefined ? { asking } : {})}
            onGoTo={(node) => {
              onGoTo(node);
              if (pullNow.current > 0) setPull(0);
            }}
            squeeze={squeeze}
            fade={fade}
            onRows={onRows}
          />
        </View>
      </RNView>
      {scrub !== null ? (
        <View position="absolute" right={RAIL_WIDTH + 14} top={Math.max(4, scrub.y - 34)} maxWidth={280} paddingVertical={8} paddingHorizontal={12} borderRadius={10} backgroundColor={t.v("text") as never} pointerEvents="none">
          {path.length > 0 ? (
            <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "bg" }} numberOfLines={1} opacity={0.75}>
              {path.join(" › ")} ›
            </Txt>
          ) : null}
          <Txt spec={{ voice: "data", scale: 14 / 12, weight: 700, color: "bg" }} numberOfLines={1}>
            {nameOf(scrub.node)}
          </Txt>
          {meta !== "" ? (
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bg" }} numberOfLines={1} opacity={0.8}>
              {meta}
            </Txt>
          ) : null}
        </View>
      ) : null}
    </RNView>
  );
}

export { RAIL_WIDTH };
