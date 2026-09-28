import { useEffect, useMemo, useState, type JSX } from "react";
import { ScrollView, TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { agoOf, chatRowMenu, controlsOf, deleteAskOf, emptyListText, forkTitleOf, isAnswering, isUnread, renamedTitle, shownConversations, unreadTitle, type ChatRow } from "@jaira/ui/chatListModel";
import type { AskSpec } from "@jaira/ui/menu";
import { projectName } from "@jaira/ui/projects";
import { copyText } from "../../clipboard";
import { Press, Txt, edge, font, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ProjectChip } from "../InboxStrip";
import { ContextMenu, type MenuAt } from "../Menu";
import { Icon } from "../panel/Icon";
import { AskDialog } from "../files/AskDialog";
import { Spinner } from "./Spinner";

/** What the list needs from the shell — `ChatSurface`'s list half (`chatPane.tsx`). */
export interface ChatListSurface {
  conversations: readonly ChatRow[];
  taskId: string | null;
  project: string | null;
  hues?: Readonly<Record<string, string>> | undefined;
  names?: Readonly<Record<string, string>> | undefined;
  producing: Readonly<Record<string, number>>;
  seen: Readonly<Record<string, number>>;
  onOpen: (taskId: string | null, project?: string) => void;
  onRename: (taskId: string, title: string, project?: string) => void;
  onDelete: (taskIds: readonly string[], project?: string) => void;
}

/**
 * `chatPane.tsx`'s `ChatListPanel`, universal (decision 0015): the Chat row's drawer — the conversations,
 * newest first, the search field the row's ⌕ reveals, a row's menu (right-click, or a long press on a
 * phone), and the rename typed in place. Which rows, the dot, the right edge and the menu are
 * `chatListModel.ts`'s, the desktop's own. The rules, from `styles.css` (`cascade.mts .chat-list`):
 *
 *   .chat-list         column, flex 1, gap 4, padding 4 0
 *   .chat-search       padding 4 8, 1px --line, radius 8, --bg, app 12/12.5
 *   .chat-rows         flex 1, scrolls
 *   .chat-rows li      row, centred, gap 6, padding 4 8, radius 6, app 12.5/12.5; hovered --panel-2;
 *                      .sel --accent 14% over transparent
 *   .chat-row-mark     7 round, 1px --line; .unread --accent filled
 *   .chat-row-title    flex 1, one line; a fork's glyph 11 square, 4 right, --accent 70% into --dim
 *   .prov              padding 0 6, 1px --line, pill, data 600 10/12.5 line 1.6, --dim
 *   .chat-row-when     app 11/12.5, --dim; answering: the spinner, 12, --accent
 *   .chat-rename       flex 1, padding 2 4, 1px --accent, radius 4, --bg, app 12.5/12.5
 *   p.empty            --dim, padding 8 0 (and a paragraph's 1em margins)
 */
export function ChatListPanel({ surface, find = false }: { surface: ChatListSurface; find?: boolean }): JSX.Element {
  const t = useTokens();
  const [query, setQuery] = useState("");
  // Dropped when the field goes away, as the desktop's.
  useEffect(() => {
    if (!find) setQuery("");
  }, [find]);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);
  const shown = useMemo(() => shownConversations(surface.conversations, query), [surface.conversations, query]);
  const open = (task: ChatRow): void => surface.onOpen(task.taskId, task.project ?? surface.project ?? undefined);
  const menuAt = (task: ChatRow, x: number, y: number): void =>
    setMenu({
      x,
      y,
      items: chatRowMenu(task, {
        open: () => open(task),
        rename: () => setRenaming({ taskId: task.taskId, title: task.title }),
        copyId: () => void copyText(task.taskId),
        askDelete: () =>
          setAsk(
            deleteAskOf(task, () => {
              setAsk(null);
              surface.onDelete([task.taskId], surface.project ?? undefined);
            }),
          ),
      }),
    });
  return (
    // `flex: 1` as the stylesheet means it where the drawer's height is its content's (the root's
    // drawer): grow from the content's height rather than from nothing, which Yoga would collapse to 0.
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} gap={4} paddingVertical={4}>
      {find ? (
        <TextInput
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
      {shown.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 1, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 1) as number}>
          {emptyListText(query)}
        </Txt>
      ) : (
        <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minHeight: 0, ...(isWeb ? { transform: "none" } : {}) } as never} contentContainerStyle={{ flexDirection: "column" }}>
          {shown.map((task) => (
            <Row
              key={task.taskId}
              task={task}
              surface={surface}
              selected={task.taskId === surface.taskId}
              renaming={renaming?.taskId === task.taskId ? renaming.title : undefined}
              onRenaming={(title) => setRenaming(title === null ? null : { taskId: task.taskId, title })}
              onOpen={() => open(task)}
              onMenu={(x, y) => menuAt(task, x, y)}
            />
          ))}
        </ScrollView>
      )}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask !== null ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </View>
  );
}

/** `.chat-rows li`: the dot, the name, what it controls, its project (at the root), and when — or the rename. */
function Row({
  task,
  surface,
  selected,
  renaming,
  onRenaming,
  onOpen,
  onMenu,
}: {
  task: ChatRow;
  surface: ChatListSurface;
  selected: boolean;
  renaming: string | undefined;
  onRenaming: (title: string | null) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const t = useTokens();
  const unread = isUnread(task, surface.seen);
  const controls = controlsOf(task);
  const fork = forkTitleOf(task);
  const ground = (hovered: boolean): string => String(selected ? t.mix(t.v("accent"), 14, "transparent") : hovered ? t.v("panel-2") : "transparent");
  const row = { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, minWidth: 0 } as const;
  if (renaming !== undefined) {
    const commit = (): void => {
      const title = renamedTitle(renaming, task.title);
      if (title !== undefined) surface.onRename(task.taskId, title, surface.project ?? undefined);
      onRenaming(null);
    };
    return (
      <View {...row} backgroundColor={ground(false) as never}>
        <TextInput
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
  // The data voice at the APP size, as `.prov`'s `font` shorthand writes it.
  const provSize = t.scaled("size-app", 10 / 12.5);
  return (
    <Press
      onPress={onOpen}
      // A phone has no right button: a long press opens the row's menu where the finger is.
      onLongPress={(e) => onMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
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
      <View
        width={7}
        height={7}
        flexShrink={0}
        borderRadius={999}
        backgroundColor={(unread ? t.v("accent") : "transparent") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, unread ? "accent" : "line") as object)}
        {...((isWeb ? { title: unreadTitle(unread) } : {}) as object)}
      />
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
      {task.project !== undefined ? <ProjectChip label={surface.names?.[task.project] ?? projectName(task.project)} hue={surface.hues?.[task.project] ?? "var(--p0)"} /> : null}
      {isAnswering(task, surface.producing) ? (
        <View flexShrink={0} flexDirection="row" alignItems="center" {...((isWeb ? { title: "Answering now" } : {}) as object)}>
          <Spinner size={12} color={String(t.v("accent"))} />
        </View>
      ) : (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} flexShrink={0}>
          {agoOf(task.updatedAt)}
        </Txt>
      )}
    </Press>
  );
}
