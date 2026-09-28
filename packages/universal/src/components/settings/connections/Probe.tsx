import { useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import { Txt, edge } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { Button } from "../Button";
import { SmallButton } from "./Row";

/**
 * `.conn-probe` and `.conn-weights`, universal (decision 0015): what answered on the usual local ports,
 * the embedded route's weights, and the MCP servers other tools here already run — a small table under
 * a row. The rules:
 *
 *   .conn-probe          30 in, 1px --line, radius 8, clipped, app 11.5/12.5
 *   .conn-probe-head     row, space-between, wraps, gap 4 12, centred, padding 5 10, --panel-2, --dim,
 *                        app 10.5/12.5; `.conn-probe-when` row, centred, gap 8, its button padding 1 8
 *   .conn-probe-row      grid 8 | 90–130 (MCP 110–190) | 1fr | auto, centred, gap 10, padding 5 10,
 *                        a --line above; `.in-use` on --tint-ok
 *   .conn-probe-dot      8 round, --rule (answering: --ok)
 *   .conn-probe-at       one line, cut with …, --dim (answering: --text)
 *   .conn-weights-row    grid 90–150 | 1fr | auto | auto; no line above the first
 *
 * A grid's `auto` column is as wide as its widest cell, and every cell is stretched to it: `useColumn`
 * is that column, which each row's cell reports its width to.
 */

/** An `auto` grid column: the widest cell's width, and how a cell reports its own. */
export interface Column {
  width: number;
  report: (key: string, width: number) => void;
}

export function useColumn(): Column {
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(new Map());
  const report = useCallback((key: string, width: number) => {
    setWidths((prev) => {
      if (prev.get(key) === width) return prev;
      const next = new Map(prev);
      next.set(key, width);
      return next;
    });
  }, []);
  return useMemo(() => ({ width: Math.max(0, ...widths.values()), report }), [widths, report]);
}

/** A cell of an `auto` column: its content at least as wide as the column, stretched to it. */
function AutoCell({ column, id, children }: { column: Column; id: string; children: ReactNode }): JSX.Element {
  return (
    <View flexShrink={0} flexDirection="row" alignItems="center">
      <View flexDirection="row" alignItems="stretch" minWidth={column.width} onLayout={(e: LayoutChangeEvent) => column.report(id, e.nativeEvent.layout.width)}>
        {children}
      </View>
    </View>
  );
}

/** `.conn-probe` / `.conn-weights`: the table's frame. */
export function ProbeList({ children, weights = false, found = false }: { children: ReactNode; weights?: boolean; found?: boolean }): JSX.Element {
  const t = useTokens();
  void weights;
  return (
    <View marginLeft={30} {...(found ? { marginTop: 6 } : {})} borderRadius={8} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {children}
    </View>
  );
}

const HEAD = { voice: "app", scale: 10.5 / 12.5, color: "dim" } as const;

/** `.conn-probe-head`: what was asked, and when (with Scan again). */
export function ProbeHead({ left, right, action }: { left: ReactNode; right: string; action?: { label: string; title: string; disabled: boolean; onPress: () => void } }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" rowGap={4} columnGap={12} paddingVertical={5} paddingHorizontal={10} backgroundColor={t.v("panel-2") as never}>
      <Txt spec={HEAD}>{left}</Txt>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={HEAD}>{right}</Txt>
        {action !== undefined ? (
          <SmallButton kind="ghost" disabled={action.disabled} onPress={action.onPress} font={{ scale: 10.5 / 12.5 }} title={action.title}>
            {action.label}
          </SmallButton>
        ) : null}
      </View>
    </View>
  );
}

const ROW = { voice: "app", scale: 11.5 / 12.5 } as const;

/** One line of the table. */
export function ProbeRow({
  up = false,
  inUse = false,
  weights = false,
  first = false,
  name,
  at,
  nameWidth,
  last,
  end,
  after,
  afterEnd,
  dimName = false,
  title,
  id,
}: {
  up?: boolean;
  inUse?: boolean;
  /** A weights row: no dot, and a fourth column. */
  weights?: boolean;
  /** The first weights row takes no line above. */
  first?: boolean;
  name: ReactNode;
  at: ReactNode;
  /** The name column: its grid track's most (130, 150; 190 for the MCP servers found). */
  nameWidth: number;
  last: Column;
  end: ReactNode;
  after?: Column;
  afterEnd?: ReactNode;
  /** `.mcp-found .conn-probe-row:not(.up) .conn-probe-name`: --dim. */
  dimName?: boolean;
  title?: string | undefined;
  /** Which row this is, for its cells' reports to the `auto` columns. */
  id?: string;
}): JSX.Element {
  const t = useTokens();
  const key = id ?? (typeof name === "string" ? name : typeof at === "string" ? at : "row");
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={10}
      paddingVertical={5}
      paddingHorizontal={10}
      {...(first ? {} : (edge(t, { top: 1 }) as object))}
      {...(inUse ? { backgroundColor: t.v("tint-ok") as never } : {})}
    >
      {weights ? null : <View width={8} height={8} borderRadius={999} flexShrink={0} backgroundColor={t.v(up ? "ok" : "rule") as never} />}
      <View width={nameWidth} flexShrink={0} minWidth={0}>
        {typeof name === "string" ? (
          <Txt spec={{ ...ROW, color: dimName ? "dim" : "text" }} numberOfLines={weights ? 1 : undefined}>
            {name}
          </Txt>
        ) : (
          name
        )}
      </View>
      <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
        {typeof at === "string" ? (
          <Txt spec={{ ...ROW, color: weights || up ? "text" : "dim" }} numberOfLines={1} {...(title !== undefined ? { title } : {})}>
            {at}
          </Txt>
        ) : (
          at
        )}
      </View>
      <AutoCell column={last} id={key}>
        {end}
      </AutoCell>
      {after !== undefined ? (
        <AutoCell column={after} id={key}>
          {afterEnd}
        </AutoCell>
      ) : null}
    </View>
  );
}

/** A `button.ghost` in a table row: the control's own padding, the row's font (`font: inherit`, app 11.5/12.5). */
export function RowButton({ disabled, onPress, title, children }: { disabled?: boolean; onPress: () => void; title?: string; children: string }): JSX.Element {
  return (
    <Button kind="ghost" disabled={disabled} onPress={onPress} font={ROW} {...(title !== undefined ? { title } : {})}>
      {children}
    </Button>
  );
}
