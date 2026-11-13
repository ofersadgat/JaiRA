import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import type { MenuAt } from "./Menu";

/** One of a list's sorts: what it is called on the head, and which way it runs when first pressed. */
export interface SortHead {
  key: string;
  label: string;
  first: "asc" | "desc";
  /**
   * What the column can show instead, chosen by a press and hold on its head (a right-click too, where
   * there is a mouse): the When column's Last message or Created. The head then wears the chosen one's
   * name, its `short` where it has one (the panel is narrow); a plain press still sorts.
   */
  choices?: ReadonlyArray<{ id: string; label: string; short?: string }>;
  choice?: string;
  onChoice?: (id: string) => void;
}

/** Where a menu opened from a head stands: under the element pressed, else where the finger was. */
function anchorOf(e: unknown): { x: number; y: number } {
  const ev = e as { currentTarget?: HTMLElement | null; target?: HTMLElement | null; nativeEvent?: { pageX?: number; pageY?: number }; clientX?: number; clientY?: number };
  const el = isWeb ? (ev.currentTarget ?? ev.target ?? null) : null;
  const box = el !== null && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : undefined;
  if (box !== undefined && box.width > 0) return { x: box.left, y: box.bottom + 4 };
  return { x: ev.clientX ?? ev.nativeEvent?.pageX ?? 0, y: ev.clientY ?? ev.nativeEvent?.pageY ?? 0 };
}

/**
 * A sidebar list's column head (the sidebar mockups, board 24): what the list is grouped by, a menu on
 * its left; its sorts on its right. The sort in use is drawn on, with its arrow; pressing it again
 * turns it round. A sort is `<key>-<asc|desc>`. The Chat and Tasks tabs' lists both wear it.
 */
export function ListHead({
  groups,
  group,
  onGroup,
  sorts,
  sort,
  onSort,
  onMenu,
}: {
  groups: ReadonlyArray<{ id: string; label: string }>;
  group: string;
  onGroup: (group: never) => void;
  sorts: readonly SortHead[];
  sort: string;
  onSort: (sort: string) => void;
  onMenu: (menu: MenuAt) => void;
}): JSX.Element {
  const t = useTokens();
  const [by, way] = sort.split("-") as [string, "asc" | "desc"];
  const groupLabel = groups.find((g) => g.id === group)?.label ?? "Nothing";
  const sortButton = (head: SortHead): JSX.Element => {
    const on = by === head.key;
    const next = on ? `${head.key}-${way === "asc" ? "desc" : "asc"}` : `${head.key}-${head.first}`;
    const chosen = head.choices?.find((c) => c.id === head.choice);
    const label = chosen?.label ?? head.label;
    const shown = chosen?.short ?? label;
    const name = label.toLowerCase();
    const choose =
      head.choices !== undefined && head.onChoice !== undefined
        ? (e: unknown): void =>
            onMenu({
              ...anchorOf(e),
              items: head.choices!.map((c) => ({ label: c.label, checked: c.id === (chosen?.id ?? head.choices![0]!.id), onSelect: () => head.onChoice!(c.id) })),
            })
        : undefined;
    const hint = choose !== undefined ? `; hold${isWeb ? " or right-click" : ""} to show ${head.choices!.filter((c) => c.id !== chosen?.id).map((c) => c.label.toLowerCase()).join(" or ")} instead` : "";
    return (
      <Press
        key={head.key}
        onPress={() => onSort(next)}
        {...(choose !== undefined
          ? {
              onLongPress: choose,
              ...((isWeb
                ? {
                    onContextMenu: (e: { preventDefault: () => void }) => {
                      e.preventDefault();
                      choose(e);
                    },
                  }
                : {}) as object),
            }
          : {})}
        label={`Sort by ${name}`}
        title={(on ? `sorted by ${name}; press to turn round` : `sort by ${name}`) + hint}
        {...((on ? { "aria-sort": way === "asc" ? "ascending" : "descending" } : {}) as object)}
        flexDirection="row"
        alignItems="center"
        gap={3}
        paddingHorizontal={5}
        height={20}
        borderRadius={4}
        box={({ hovered }) => ({ backgroundColor: on ? t.v("panel-3") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: on ? 600 : 500, color: on ? "text" : "dim" }} whiteSpace="nowrap">
          {shown}
        </Txt>
        {on ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{way === "asc" ? "↑" : "↓"}</Txt> : null}
      </Press>
    );
  };
  return (
    <View flexDirection="row" alignItems="center" gap={4} height={24} paddingHorizontal={4} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
      <Press
        onPress={(e) => {
          const box = isWeb ? (e as unknown as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect() : undefined;
          const touch = (e as unknown as { nativeEvent?: { pageX?: number; pageY?: number } }).nativeEvent;
          onMenu({
            x: box?.left ?? touch?.pageX ?? 0,
            y: box !== undefined ? box.bottom + 4 : (touch?.pageY ?? 0),
            items: groups.map((g) => ({ label: g.label, checked: g.id === group, onSelect: () => onGroup(g.id as never) })),
          });
        }}
        label={`Grouped by ${groupLabel.toLowerCase()}; change`}
        title="group by"
        {...({ "aria-haspopup": "menu" } as object)}
        flexDirection="row"
        alignItems="center"
        gap={4}
        paddingHorizontal={5}
        height={20}
        borderRadius={4}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{`▤ ${group === "none" ? "Not grouped" : groupLabel} ⌄`}</Txt>
      </Press>
      <View flex={1} />
      {sorts.map(sortButton)}
    </View>
  );
}
