import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { BoardCard } from "@jaira/shared/browser";
import { agoOf } from "@jaira/ui/chatListModel";
import { TASK_WHENS, TASK_WHEN_LABELS, cardWhenOf, standingOf, type TaskSection, type TaskWhen } from "@jaira/ui/taskListModel";
import { PLAIN_SCROLLER, Press, Txt, scrollbarProps, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { ListHead, type SortHead } from "../ListHead";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { pressWasDrag } from "../../app/placeDrag";

/** The Tasks list's sorts: State most urgent first, Name A to Z, When newest first; When shows the last activity or the making. */
export function taskSortHeads(head: Pick<TaskListHead, "when" | "onWhen">): SortHead[] {
  return [
    { key: "state", label: "State", first: "asc" },
    { key: "name", label: "Name", first: "asc" },
    {
      key: "when",
      label: "When",
      first: "desc",
      choices: TASK_WHENS.map((id) => ({ id, label: TASK_WHEN_LABELS[id] })),
      choice: head.when,
      onChoice: (id) => head.onWhen(id as TaskWhen),
    },
  ];
}

export interface TaskListHead {
  groups: ReadonlyArray<{ id: string; label: string }>;
  group: string;
  onGroup: (group: never) => void;
  sort: string;
  onSort: (sort: string) => void;
  /** What the When column says and sorts by: the last activity (the default), or when it was made. */
  when: TaskWhen;
  onWhen: (when: TaskWhen) => void;
}

/**
 * The project panel's Tasks tab (the sidebar mockups, boards 39, 44, 47): the project's tasks under
 * the column head, each row a status square, its title, where it stands in a word, and how long ago.
 * Hovered, a row offers Stop (while it runs or waits) and ⋯, the board card's own menu (right-click
 * opens it too; a long press on a phone). Pressing a row opens the task. How it looks:
 *
 *   a row          26 tall, padding 0 8, radius 6, gap 6; hovered --panel-2, the open one --accent 14%
 *   its square     8, radius 2, in its standing's colour
 *   its word       app 11/12.5 in its standing's colour (Done in --dim)
 *   a group head   data 600 11/12.5 --dim (Asks you in --warn, Failed in --bad), its count at the right
 */
export function TaskListPanel({
  sections,
  empty,
  selected,
  head,
  onOpen,
  onMenu,
  onStop,
}: {
  sections: readonly TaskSection[];
  empty: string;
  selected: string | null;
  head: TaskListHead;
  onOpen: (card: BoardCard) => void;
  onMenu: (card: BoardCard, x: number, y: number) => void;
  onStop: (card: BoardCard) => void;
}): JSX.Element {
  const t = useTokens();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const count = sections.reduce((n, s) => n + s.rows.length, 0);
  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} gap={2} paddingVertical={2}>
      <ListHead groups={head.groups} group={head.group} onGroup={head.onGroup} sort={head.sort} onSort={head.onSort} sorts={taskSortHeads(head)} onMenu={setMenu} />
      {count === 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} paddingHorizontal={8}>
          {empty}
        </Txt>
      ) : (
        <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minHeight: 0, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ flexDirection: "column", ...PLAIN_SCROLLER } as never}>
          {sections.map((section) => (
            <View key={section.key} flexDirection="column">
              {section.label !== "" ? (
                <View flexDirection="row" alignItems="center" gap={6} paddingHorizontal={8} paddingTop={8} paddingBottom={3}>
                  <Txt spec={{ voice: "data", scale: 11 / 12.5, weight: 600, color: section.tone ?? "dim" }} ellip flex={1} minWidth={0}>
                    {section.label}
                  </Txt>
                  <Txt spec={{ voice: "data", scale: 11 / 12.5, color: "dim" }}>{String(section.rows.length)}</Txt>
                </View>
              ) : null}
              {section.rows.map((card) => (
                <TaskRow key={card.taskId} card={card} when={head.when} selected={card.taskId === selected} onOpen={() => onOpen(card)} onMenu={(x, y) => onMenu(card, x, y)} onStop={() => onStop(card)} />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

function TaskRow({ card, when, selected, onOpen, onMenu, onStop }: { card: BoardCard; when: TaskWhen; selected: boolean; onOpen: () => void; onMenu: (x: number, y: number) => void; onStop: () => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const standing = standingOf(card);
  const stoppable = card.status === "running" || card.status === "queued" || card.status === "interrupted";
  const ground = (on: boolean): string => String(selected ? t.mix(t.v("accent"), 14, "transparent") : on ? t.v("panel-2") : "transparent");
  const hoverGround = String(selected ? t.mix(t.v("accent"), 14, t.v("panel-2")) : t.v("panel-2"));
  const tool = (label: string, glyph: string, press: (e: unknown) => void): JSX.Element => (
    <Press
      onPress={press}
      label={`${card.title}: ${label.toLowerCase()}`}
      title={label.toLowerCase()}
      width={22}
      height={22}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      box={({ hovered: on }) => ({ backgroundColor: on ? t.v("panel-3") : hoverGround })}
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{glyph}</Txt>
    </Press>
  );
  return (
    // The row's tools are siblings of its button, over its right end: a button in a button is not one.
    // On web it can be dragged onto a pane (decision 0025, `placeDrag.ts`): it says what it is.
    <View {...(hover as object)} position="relative" {...((isWeb ? { "data-drag-task": card.taskId, "data-drag-project": card.project ?? "", "data-drag-label": card.title } : {}) as object)}>
      <Press
        onPress={onOpen}
        onLongPress={(e) => !pressWasDrag() && onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
        {...((isWeb
          ? {
              onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
                e.preventDefault();
                onMenu(e.clientX, e.clientY);
              },
            }
          : {}) as object)}
        label={`${card.title}, ${standing.word.toLowerCase()}`}
        flexDirection="row"
        alignItems="center"
        gap={6}
        height={26}
        paddingHorizontal={8}
        borderRadius={6}
        minWidth={0}
        box={({ hovered: on }) => ({ backgroundColor: ground(on) })}
      >
        <View width={8} height={8} borderRadius={2} flexShrink={0} backgroundColor={t.v(standing.tone === "dim" ? "line" : standing.tone) as never} />
        <Txt spec={{ voice: "app", scale: 1, color: "text" }} ellip flex={1} minWidth={0}>
          {card.title}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: standing.tone === "ok" ? "dim" : standing.tone }} flexShrink={0} whiteSpace="nowrap">
          {standing.word}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} flexShrink={0} minWidth={22} textAlign="right" {...((isWeb ? { title: `${TASK_WHEN_LABELS[when]} ${new Date(cardWhenOf(card, when)).toLocaleString()}` } : {}) as object)}>
          {agoOf(cardWhenOf(card, when))}
        </Txt>
      </Press>
      {hovered && isWeb ? (
        <View position="absolute" right={3} top={2} bottom={2} flexDirection="row" alignItems="center" gap={2}>
          {stoppable ? tool("Stop", "■", () => onStop()) : null}
          {tool("More", "⋯", (e) => {
            const box = (e as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect();
            onMenu(box.right - MENU_WIDTH, box.bottom + 4);
          })}
        </View>
      ) : null}
    </View>
  );
}
