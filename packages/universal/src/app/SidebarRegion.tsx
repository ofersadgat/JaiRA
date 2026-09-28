import { useMemo, useState, type JSX } from "react";
import { hueOf } from "@jaira/ui/pill";
import { FOOTER_VIEWS, ROOT_VIEWS, VIEWS, roomCountsOf, sidebarProjectsOf } from "@jaira/ui/shellModel";
import type { SidebarAct, SidebarView } from "@jaira/ui/sidebar";
import type { View as AppView } from "@jaira/ui/store";
import { FOLD, PANE, openOf, paneOf } from "@jaira/ui/uiState";
import { healthCounts, logUnseen } from "@jaira/ui/updatesModel";
import { useHealth } from "@jaira/ui/updatesStore";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { Sidebar } from "../components/Sidebar";
import { useShell } from "./shell";
import { Uncopied } from "./Uncopied";

/**
 * The sidebar, with the rows `App.tsx` gives its own: the rooms, their counts (`shellModel.ts`, one
 * derivation for both shells), their verbs, and the drawers each opens onto. A drawer with no copy yet is
 * an {@link Uncopied} box where it stands.
 */
export function ShellSidebar(): JSX.Element {
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
