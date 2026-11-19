import { useEffect, useMemo, useState, type JSX } from "react";
import { ScrollView, TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { CHAT_GROUP_LABELS, CHAT_WHENS, CHAT_WHEN_LABELS, CHAT_WHEN_SHORT, arrangeConversations, whenOf, type ChatGroup, type ChatSort, type ChatWhen, agoOf, chatRowMenu, controlsOf, deleteAskOf, emptyListText, forkTitleOf, isUnread, renamedTitle, shownConversations, type ChatRow } from "@jaira/ui/chatListModel";
import type { AskSpec } from "@jaira/ui/menuTypes";
import { projectName } from "@jaira/ui/projects";
import { copyText } from "../../clipboard";
import { PLAIN_SCROLLER, ENTER_KEEPS_FOCUS, Press, Txt, edge, font, scrollbarProps, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { ProjectChip } from "../InboxStrip";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { pressWasDrag } from "../../app/placeDrag";
import { Icon } from "../panel/Icon";
import { AskDialog } from "../files/AskDialog";
import { ListHead, type SortHead } from "../ListHead";
import { Spinner } from "./Spinner";
import { RowRing, RowRingClock } from "../StatusRing";
import { chatRingItems } from "@jaira/ui/ringModel";

/** What the list needs from the shell — `ChatSurface`'s list half (`chatSurface.ts`). */
export interface ChatListSurface {
  conversations: readonly ChatRow[];
  /** The project a row without its own is in — `ChatSurface.listed`. */
  listed: string | null;
  /** Whether the rows are of several projects, so each names its own — `ChatSurface.spans`. Absent: they do. */
  spans?: boolean;
  /** Inside a project: a row's workspace, where it says something — `ChatSurface.places`. */
  places?: Readonly<Record<string, string>> | undefined;
  taskId: string | null;
  project: string | null;
  hues?: Readonly<Record<string, string>> | undefined;
  names?: Readonly<Record<string, string>> | undefined;
  producing: Readonly<Record<string, number>>;
  /** The conversations that have not started: being placed, or waiting for a workspace with room. */
  unplaced?: Readonly<Record<string, "placing" | "waiting">> | undefined;
  /** When each conversation asked the person, for its ring — `ChatSurface.asked`. */
  asked?: Readonly<Record<string, number>> | undefined;
  seen: Readonly<Record<string, number>>;
  onOpen: (taskId: string | null, project?: string) => void;
  onRename: (taskId: string, title: string, project?: string) => void;
  onDelete: (taskIds: readonly string[], project?: string) => void;
  /** End a conversation that waits for its next message — `ChatSurface.onEnd`. Absent: a row's menu has no End. */
  onEnd?: (taskId: string, project?: string) => void;
}

/**
 * How the list is arranged, and the column head that changes it (the sidebar mockups, board 24): a
 * group menu on its left, Name and When on its right, a second press turning a sort round. Absent: the
 * list is newest first, ungrouped, with no head.
 */
export interface ChatArrange {
  group: ChatGroup;
  sort: ChatSort;
  /** The groupings this list offers: Workspace only where the project has several. */
  groups: readonly ChatGroup[];
  /** What to call the project's own workspace, as a group's head. */
  home: string;
  onGroup: (group: ChatGroup) => void;
  onSort: (sort: ChatSort) => void;
  /** What the When column says and sorts by: the last message (the default), or when it was made. */
  when: ChatWhen;
  onWhen: (when: ChatWhen) => void;
  /** Pinned conversations, first in a section of their own, and pinning one or letting it go. */
  pinned: ReadonlySet<string>;
  onPin: (taskId: string, on: boolean) => void;
  onMarkUnread: (taskId: string) => void;
  /** Where a conversation waiting for a workspace can be sent instead — none once it has started. */
  runOn: (task: ChatRow) => ReadonlyArray<{ label: string; note?: string; onSelect: () => void }>;
}

/** The chat list's sorts: Name A to Z first, When newest first; When shows the last message or the making. */
function chatSortHeads(arrange: ChatArrange): SortHead[] {
  return [
    { key: "name", label: "Name", first: "asc" },
    {
      key: "when",
      label: "When",
      first: "desc",
      choices: CHAT_WHENS.map((id) => ({ id, label: CHAT_WHEN_LABELS[id], short: CHAT_WHEN_SHORT[id] })),
      choice: arrange.when,
      onChoice: (id) => arrange.onWhen(id as ChatWhen),
    },
  ];
}

/** Where a row's conversation is: its own project, else the one the list was read from. */
function homeOf(task: ChatRow, surface: ChatListSurface): string | undefined {
  return task.project ?? surface.listed ?? surface.project ?? undefined;
}

/**
 * The Chat row's drawer: the conversations, newest first, the search field the row's ⌕ reveals, a
 * row's menu (right-click, or a long press on a phone), and the rename typed in place. Which rows, the
 * dot, the right edge and the menu are `chatListModel.ts`'s. How it looks:
 *
 *   the list           column, flex 1, gap 4, padding 4 0
 *   the search field   padding 4 8, 1px --line, radius 8, --bg, app 12/12.5
 *   the rows           flex 1, scrolls
 *   a row              row, centred, gap 6, padding 4 8, radius 6, app 12.5/12.5; hovered --panel-2;
 *                      selected --accent 14% over transparent
 *   its ring           22 round (`StatusRing.tsx`): a segment for answering, asking, and how it
 *                      stopped while unread; the oldest ask's age, or the answer's clock, inside
 *   its title          flex 1, one line; a fork's glyph 11 square, 4 right, --accent 70% into --dim
 *   what it controls   padding 0 6, 1px --line, pill, data 600 10/12.5 line 1.6, --dim
 *   when               app 11/12.5, --dim, only while the ring is empty; else the work's clock
 *                      (data 600, --accent) when the ring's middle tells a wait, else nothing
 *   the rename         flex 1, padding 2 4, 1px --accent, radius 4, --bg, app 12.5/12.5
 *   empty              --dim, padding 8 0 (and a paragraph's 1em margins)
 */
export function ChatListPanel({ surface, find = false, arrange }: { surface: ChatListSurface; find?: boolean; arrange?: ChatArrange | undefined }): JSX.Element {
  const t = useTokens();
  const [query, setQuery] = useState("");
  // Dropped when the field goes away.
  useEffect(() => {
    if (!find) setQuery("");
  }, [find]);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);
  const shown = useMemo(() => shownConversations(surface.conversations, query), [surface.conversations, query]);
  const sections = useMemo(
    () =>
      arrangeConversations(shown, { group: arrange?.group ?? "none", sort: arrange?.sort ?? "when-desc", when: arrange?.when ?? "message" }, {
        seen: surface.seen,
        producing: surface.producing,
        placeOf: (row) => (row.project === undefined ? undefined : surface.places?.[row.project]),
        home: arrange?.home ?? "",
        ...(arrange !== undefined ? { pinned: arrange.pinned } : {}),
      }),
    [shown, arrange?.group, arrange?.sort, arrange?.when, arrange?.home, arrange?.pinned, surface.seen, surface.producing, surface.places],
  );
  const open = (task: ChatRow): void => surface.onOpen(task.taskId, homeOf(task, surface));
  const menuAt = (task: ChatRow, x: number, y: number): void =>
    setMenu({
      x,
      y,
      items: chatRowMenu(task, {
        open: () => open(task),
        rename: () => setRenaming({ taskId: task.taskId, title: task.title }),
        copyId: () => void copyText(task.taskId),
        ...(surface.onEnd !== undefined && task.waitsForMessage === true ? { end: () => surface.onEnd!(task.taskId, homeOf(task, surface)) } : {}),
        ...(arrange !== undefined
          ? {
              pinned: arrange.pinned.has(task.taskId),
              pin: (on: boolean) => arrange.onPin(task.taskId, on),
              unread: isUnread(task, surface.seen),
              markUnread: () => arrange.onMarkUnread(task.taskId),
              runOn: surface.unplaced?.[task.taskId] !== undefined ? arrange.runOn(task) : [],
            }
          : {}),
        askDelete: () =>
          setAsk(
            deleteAskOf(task, () => {
              setAsk(null);
              surface.onDelete([task.taskId], homeOf(task, surface));
            }),
          ),
      }),
    });
  return (
    // `flex: 1` as CSS means it where the drawer's height is its content's (the root's
    // drawer): grow from the content's height rather than from nothing, which Yoga would collapse to 0.
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} gap={4} paddingVertical={4}>
      {find ? (
        <TextInput {...(ENTER_KEEPS_FOCUS as object)}
          autoFocus
          value={query}
          placeholder="Search conversations"
          onChangeText={setQuery}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Escape") setQuery("");
          }}
          style={{
            ...(font(t, { voice: "app", scale: 12 / 12.5, color: "text" }) as object),
            paddingVertical: 4,
            paddingHorizontal: 8,
            backgroundColor: t.v("bg"),
            borderRadius: 8,
            ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object),
          } as never}
        />
      ) : null}
      {arrange !== undefined ? <ListHead groups={arrange.groups.map((g) => ({ id: g, label: CHAT_GROUP_LABELS[g] }))} group={arrange.group} onGroup={arrange.onGroup} sorts={chatSortHeads(arrange)} sort={arrange.sort} onSort={(s) => arrange.onSort(s as ChatSort)} onMenu={setMenu} /> : null}
      {shown.length === 0 ? (
        // The empty line: the body's own size (13/12.5), --dim, padding 8 0, a paragraph's 1em above and below.
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
          {emptyListText(query)}
        </Txt>
      ) : (
        <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minHeight: 0, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ flexDirection: "column", ...PLAIN_SCROLLER } as never}>
          {sections.map((section) => (
            <View key={section.key} flexDirection="column">
              {section.label !== "" ? (
                <View flexDirection="row" alignItems="center" gap={6} paddingHorizontal={8} paddingTop={8} paddingBottom={3}>
                  <Txt spec={{ voice: "data", scale: 11 / 12.5, weight: 600, color: "dim" }} ellip flex={1} minWidth={0}>
                    {section.label}
                  </Txt>
                  <Txt spec={{ voice: "data", scale: 11 / 12.5, color: "dim" }}>{String(section.rows.length)}</Txt>
                </View>
              ) : null}
              {section.rows.map((task) => (
                <Row
                  key={task.taskId}
                  task={task}
                  when={arrange?.when ?? "message"}
                  surface={surface}
                  selected={task.taskId === surface.taskId}
                  renaming={renaming?.taskId === task.taskId ? renaming.title : undefined}
                  onRenaming={(title) => setRenaming(title === null ? null : { taskId: task.taskId, title })}
                  onOpen={() => open(task)}
                  onMenu={(x, y) => menuAt(task, x, y)}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask !== null ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </View>
  );
}

/** A row: the dot, the name, what it controls, its project (at the root), and when — or the rename. */
function Row({
  task,
  when,
  surface,
  selected,
  renaming,
  onRenaming,
  onOpen,
  onMenu,
}: {
  task: ChatRow;
  when: ChatWhen;
  surface: ChatListSurface;
  selected: boolean;
  renaming: string | undefined;
  onRenaming: (title: string | null) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const ring = useMemo(
    () => chatRingItems(task, { seen: surface.seen, producing: surface.producing, askedAt: surface.asked?.[task.taskId] }),
    [task, surface.seen, surface.producing, surface.asked],
  );
  const controls = controlsOf(task);
  const fork = forkTitleOf(task);
  const ground = (hovered: boolean): string => String(selected ? t.mix(t.v("accent"), 14, "transparent") : hovered ? t.v("panel-2") : "transparent");
  const row = { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, minWidth: 0 } as const;
  if (renaming !== undefined) {
    const commit = (): void => {
      const title = renamedTitle(renaming, task.title);
      if (title !== undefined) surface.onRename(task.taskId, title, homeOf(task, surface));
      onRenaming(null);
    };
    return (
      <View {...row} backgroundColor={ground(false) as never}>
        <TextInput {...(ENTER_KEEPS_FOCUS as object)}
          autoFocus
          value={renaming}
          onChangeText={(title) => onRenaming(title)}
          onBlur={() => onRenaming(null)}
          onSubmitEditing={commit}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Escape") onRenaming(null);
          }}
          style={{
            ...(font(t, { voice: "app", scale: 1, color: "text" }) as object),
            flex: 1,
            minWidth: 0,
            paddingVertical: 2,
            paddingHorizontal: 4,
            backgroundColor: t.v("bg"),
            borderRadius: 4,
            ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "accent") as object),
            ...(isWeb ? { outlineStyle: "none" } : {}),
          } as never}
        />
      </View>
    );
  }
  // What it controls, in its pill: the data voice at the APP size.
  const provSize = t.scaled("size-app", 10 / 12.5);
  return (
    // A row's own actions behind a ⋯ that shows on hover, over its right end (the sidebar mockups,
    // board 28) — the menu its right-click opens, for a person who does not know to right-click. A
    // sibling of the row's button, not inside it: a button in a button is not one. On web it can be
    // dragged onto a pane (decision 0025, `placeDrag.ts`): it says what it is.
    <View {...(hover as object)} position="relative" {...((isWeb ? { "data-drag-task": task.taskId, "data-drag-project": homeOf(task, surface) ?? "", "data-drag-label": task.title } : {}) as object)}>
    <Press
      onPress={onOpen}
      // A phone has no right button: a long press opens the row's menu where the finger is.
      onLongPress={(e) => !pressWasDrag() && onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      {...((isWeb
        ? {
            onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            },
          }
        : {}) as object)}
      {...row}
      box={({ hovered }) => ({ backgroundColor: ground(hovered) })}
    >
      <RowRing items={ring} />
      <Txt spec={{ voice: "app", scale: 1, color: "text" }} ellip flex={1} minWidth={0} {...((isWeb && fork !== undefined ? { title: fork } : {}) as object)}>
        {task.origin !== undefined ? (
          <View display={"inline-flex" as never} width={11} height={11} marginRight={4} {...((isWeb ? { verticalAlign: -1 } : {}) as object)}>
            <Icon name="choice" size={11} color={String(t.mix(t.v("accent"), 70, t.v("dim")))} />
          </View>
        ) : null}
        {task.title}
      </Txt>
      {controls !== undefined ? (
        <View flexShrink={0} paddingHorizontal={6} borderRadius={999} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} {...((isWeb ? { title: controls.title } : {}) as object)}>
          <Txt spec={{ voice: "data", scale: 1, weight: 600, color: "dim" }} fontSize={provSize} lineHeight={typeof provSize === "number" ? provSize * 1.6 : "1.6"}>
            {controls.label}
          </Txt>
        </View>
      ) : null}
      {task.project !== undefined && surface.spans !== false ? <ProjectChip label={surface.names?.[task.project] ?? projectName(task.project)} hue={surface.hues?.[task.project] ?? "var(--p0)"} /> : null}
      {task.project !== undefined && surface.spans === false && surface.places?.[task.project] !== undefined ? (
        <Txt spec={{ voice: "data", scale: 10 / 12.5, color: "dim" }} flexShrink={0} whiteSpace="nowrap">
          {surface.places[task.project]}
        </Txt>
      ) : null}
      {surface.unplaced?.[task.taskId] === "waiting" ? (
        <View flexShrink={0} flexDirection="row" alignItems="center" {...((isWeb ? { title: "Waiting for a workspace with room" } : {}) as object)}>
          <Icon name="clock" size={12} color={String(t.v("warn"))} />
        </View>
      ) : surface.unplaced?.[task.taskId] === "placing" ? (
        <View flexShrink={0} flexDirection="row" alignItems="center" {...((isWeb ? { title: "Finding somewhere for it to run" } : {}) as object)}>
          <Spinner size={12} color={String(t.v("dim"))} />
        </View>
      ) : ring.length > 0 ? (
        // The ring says how long; the row's end says only the work's clock beside a wait (board 11).
        <RowRingClock items={ring} />
      ) : (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} flexShrink={0} {...((isWeb ? { title: `${CHAT_WHEN_LABELS[when]} ${new Date(whenOf(task, when)).toLocaleString()}` } : {}) as object)}>
          {agoOf(whenOf(task, when))}
        </Txt>
      )}
    </Press>
    {hovered && isWeb ? (
      <Press
        onPress={(e) => {
          const box = (e as unknown as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect();
          onMenu(box.right - MENU_WIDTH, box.bottom + 4);
        }}
        label={`${task.title}: more`}
        title="more"
        {...({ "aria-haspopup": "menu" } as object)}
        position="absolute"
        right={3}
        top={2}
        bottom={2}
        width={24}
        alignItems="center"
        justifyContent="center"
        borderRadius={5}
        box={({ hovered: on }) => ({ backgroundColor: on ? t.v("panel-3") : String(selected ? t.mix(t.v("accent"), 14, t.v("panel-2")) : t.v("panel-2")) })}
      >
        <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>⋯</Txt>
      </Press>
    ) : null}
    </View>
  );
}

