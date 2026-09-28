import { createContext, useContext, useMemo, useState, type JSX } from "react";
import { Text, View } from "@tamagui/core";
import { hueOf } from "@jaira/ui/pill";
import { FOOTER_VIEWS, ROOT_VIEWS, VIEWS, roomCountsOf, sidebarProjectsOf } from "@jaira/ui/shellModel";
import type { SidebarAct, SidebarView } from "@jaira/ui/sidebar";
import { useApp, type View as AppView } from "@jaira/ui/store";
import { FOLD, PANE, openOf, paneOf } from "@jaira/ui/uiState";
import { healthCounts, logUnseen } from "@jaira/ui/updatesModel";
import { useHealth } from "@jaira/ui/updatesStore";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { Sidebar } from "../components/Sidebar";
import { edge } from "../primitives";
import { TokenRoot, useTokens } from "../tokens";

/**
 * The desktop's shell, universal (decision 0015): `App.tsx`'s frame drawn from copies, on a phone and in
 * the `/rn` page that tests the phone's path in a browser. The same store drives it — `useApp()`, once,
 * here, as `App.tsx` calls it once — so this is a second VIEW of the one state, not a second app.
 *
 * What is not copied yet is drawn as {@link Uncopied}: a labelled box where the region stands, so what is
 * left is visible on the screen and in every gate picture, rather than silently missing.
 */
export type AppModel = ReturnType<typeof useApp>;
const AppContext = createContext<AppModel | null>(null);

/** The store, for any copy inside {@link UniversalApp}. */
export function useShell(): AppModel {
  const model = useContext(AppContext);
  if (model === null) throw new Error("useShell() outside <UniversalApp>");
  return model;
}

export function UniversalApp(): JSX.Element {
  const model = useApp();
  return (
    <AppContext.Provider value={model}>
      <TokenRoot {...model.appearance}>
        <Frame />
      </TokenRoot>
    </AppContext.Provider>
  );
}

/**
 * `.app`: the sidebar, its splitter, and the body — a row the height of the window. The body is the
 * address bar over the viewport, and the inbox strip under both.
 */
function Frame(): JSX.Element {
  const t = useTokens();
  return (
    <View flex={1} flexDirection="row" overflow="hidden" backgroundColor={t.v("bg") as never}>
      <ShellSidebar />
      {/* `.splitter`: 6 wide, a 2px --line down its middle (`::before`, inset 0 2px). Dragged on the desktop. */}
      {openOf(useShell().state.settings.ui, FOLD.shellSidebar) ? (
        <View width={6} flexShrink={0} alignItems="center">
          <View width={2} flex={1} backgroundColor={t.v("line") as never} />
        </View>
      ) : null}
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column">
        <View flexDirection="row" alignItems="stretch" flexShrink={0} minHeight={34} backgroundColor={t.v("panel") as never} {...(edge(t, { bottom: 1 }) as object)}>
          <Uncopied name="TaskAddressBar" flex={1} />
        </View>
        <View flex={1} minHeight={0} flexDirection="row">
          <Uncopied name="Board" flex={1} />
        </View>
        <Uncopied name="InboxStrip" height={48} />
      </View>
    </View>
  );
}

/** A region with no copy yet: its name, where it stands. */
export function Uncopied({ name, ...box }: { name: string; width?: number; height?: number; flex?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View {...box} testID={`uncopied-${name}`} borderWidth={1} borderStyle="dashed" borderColor={t.v("dim") as never} alignItems="center" justifyContent="center" padding={8}>
      <Text fontSize={12} color={t.v("dim") as never}>
        {name} (not copied yet)
      </Text>
    </View>
  );
}

/**
 * The sidebar, with the rows `App.tsx` gives its own: the rooms, their counts (`shellModel.ts`, one
 * derivation for both shells), their verbs, and the drawers each opens onto. A drawer with no copy yet is
 * an {@link Uncopied} box where it stands.
 */
function ShellSidebar(): JSX.Element {
  const { state, actions, appearance } = useShell();
  const ui = state.settings.ui;
  const health = useHealth();
  const [finding, setFinding] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupProjects(state.projects, ui.groupWorkspaces !== false), [state.projects, ui.groupWorkspaces]);
  const projectHues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  const rooms = roomCountsOf(state.projects, state.allConversations, groups, state.at, ui.seen);
  const find = (id: string): SidebarAct => ({
    id: "find",
    glyph: "⌕",
    label: `find in ${id}`,
    on: finding[id] === true,
    onAct: () => setFinding((f) => ({ ...f, [id]: !(f[id] ?? false) })),
  });
  const newChat: SidebarAct = {
    id: "new",
    glyph: "+",
    label: "new conversation",
    onAct: () => {
      actions.setView("chat");
      actions.openConversation(null);
    },
  };
  const roots: SidebarView[] = ROOT_VIEWS.map((v) =>
    v.id !== "chat"
      ? { ...v, counts: rooms.rootTasks, onSeen: () => actions.markSeenAll(rooms.seenRootTasks) }
      : {
          ...v,
          counts: rooms.rootChat,
          onSeen: () => actions.markSeenAll(rooms.seenRootChat),
          acts: [{ ...newChat, onAct: (from) => (actions.standOn(null), newChat.onAct(from)) }, find("conversations")],
          panel: <Uncopied name="ChatListPanel" flex={1} />,
        },
  );
  const views: SidebarView[] = VIEWS.map((v) =>
    v.id === "tasks"
      ? { ...v, counts: rooms.atTasks, onSeen: () => actions.markSeenAll(rooms.seenAtTasks) }
      : v.id === "chat"
        ? { ...v, counts: rooms.atChat, onSeen: () => actions.markSeenAll(rooms.seenAtChat), acts: [newChat, find("chat")], panel: <Uncopied name="ChatListPanel" flex={1} /> }
        : { ...v, acts: [{ id: "new", glyph: "+", label: "new file, folder or workflow", onAct: () => undefined }, find("files")], panel: <Uncopied name="FileTreePanel" flex={1} /> },
  );
  const footer = FOOTER_VIEWS.map((row) => (row.id === "logs" ? { ...row, counts: logUnseen(health)?.counts ?? {}, seenTitle: "What needs attention" } : row));
  const settings: SidebarView = {
    id: "settings",
    glyph: "⚙",
    label: "Settings",
    counts: healthCounts(health),
    seenTitle: "What needs attention",
    panel: <Uncopied name="SettingsSections" flex={1} />,
  };
  return (
    <Sidebar
      views={views}
      roots={roots}
      footer={footer}
      settings={settings}
      onLeaveSettings={() => actions.setView("tasks")}
      view={state.view}
      onView={(id) => actions.setView(id as AppView)}
      collapsed={!openOf(ui, FOLD.shellSidebar)}
      onCollapsed={(shut) => actions.setFold(FOLD.shellSidebar, !shut)}
      width={paneOf(ui, PANE.shellSidebar)}
      projects={sidebarProjectsOf(groups, projectHues, ui.seen, actions.markProjectSeen)}
      at={groupOf(groups, state.at)?.key ?? state.at}
      onProject={actions.standOn}
      busy={state.busy}
      theme={appearance.scheme}
      onTheme={actions.setTheme}
      onChooseProject={(mode) => void actions.chooseProject(mode)}
      onProjectSettings={(p) => {
        actions.standOn(p.project);
        actions.setConfigLayer(p.kind === "shared" ? "base" : "project");
        actions.setView("settings");
      }}
    />
  );
}
