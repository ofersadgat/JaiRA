import { useMemo, useState, type JSX } from "react";
import { hueOf } from "@jaira/ui/pill";
import { FOOTER_VIEWS, ROOT_VIEWS, VIEWS, roomCountsOf, sidebarProjectsOf } from "@jaira/ui/shellModel";
import type { SidebarAct, SidebarView } from "@jaira/ui/sidebar";
import type { View as AppView } from "@jaira/ui/store";
import { newItems, standingRoot, type TreeDraft } from "@jaira/ui/filesModel";
import { FOLD, OPENED, PANE, openOf, paneOf, unfoldedOf } from "@jaira/ui/uiState";
import { healthCounts, logUnseen } from "@jaira/ui/updatesModel";
import { useHealth } from "@jaira/ui/updatesStore";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { settingsPageProblems } from "@jaira/ui/settingsSections";
import { FileTreePanel } from "../components/files/FileTreePanel";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../components/Menu";
import { Sidebar } from "../components/Sidebar";
import { SettingsSections } from "../components/settings/SettingsSections";
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
  /**
   * The `+` on the Files row: the menu it drops, and the row in the tree it starts — `App.tsx`'s
   * `newMenu` and `newDraft`, held here because the row and the drawer are both this region's.
   */
  const [newMenu, setNewMenu] = useState<MenuAt | null>(null);
  const [newDraft, setNewDraft] = useState<TreeDraft | null>(null);
  const newFile: SidebarAct = {
    id: "new",
    glyph: "+",
    label: "new file, folder or workflow",
    onAct: (from) => {
      const root = standingRoot(state.tree, state.at);
      if (root === null) return;
      // Right-aligned under the button, as `App.tsx` places it.
      const box = anchorBox(from, "new file, folder or workflow");
      setNewMenu({
        x: Math.max(4, box.right - MENU_WIDTH),
        y: box.bottom + 4,
        items: newItems(root, "", (draft) => {
          actions.setView("files");
          if (draft.reveal.length > 0) actions.unfold(OPENED.folders, draft.reveal);
          setNewDraft(draft);
        }),
      });
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
        : { ...v, acts: [newFile, find("files")], panel: <FilesDrawer find={finding.files === true} draft={newDraft} onDraft={setNewDraft} /> },
  );
  const footer = FOOTER_VIEWS.map((row) => (row.id === "logs" ? { ...row, counts: logUnseen(health)?.counts ?? {}, seenTitle: "What needs attention" } : row));
  const settings: SidebarView = {
    id: "settings",
    glyph: "⚙",
    label: "Settings",
    counts: healthCounts(health),
    seenTitle: "What needs attention",
    panel: (
      <SettingsSections
        section={state.section}
        open={state.view === "settings"}
        problems={(id) => settingsPageProblems(health, id)}
        onSection={(id) => {
          actions.setSection(id);
          // From Logs or Debug this row is a way BACK into Settings, so it has to go there.
          actions.setView("settings");
        }}
      />
    ),
  };
  return (
    <>
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
    {newMenu !== null ? <ContextMenu anchor={newMenu} onClose={() => setNewMenu(null)} /> : null}
    </>
  );
}

/**
 * Where the row's `+` stands, for the menu it drops. The DOM sidebar hands its act the button; this
 * one's `Sidebar` hands it nothing yet, so on web the button is found by its label, and on native the
 * menu hangs from the top of the column.
 */
function anchorBox(from: unknown, label: string): { right: number; bottom: number } {
  const el =
    from !== undefined && from !== null && typeof (from as HTMLElement).getBoundingClientRect === "function"
      ? (from as HTMLElement)
      : typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (el === null) return { right: MENU_WIDTH + 4, bottom: 60 };
  const box = el.getBoundingClientRect();
  return { right: box.right, bottom: box.bottom };
}

/** The Files drawer (`FileTreePanel`), with the props `App.tsx` gives its own. */
function FilesDrawer({ find, draft, onDraft }: { find: boolean; draft: TreeDraft | null; onDraft: (draft: TreeDraft | null) => void }): JSX.Element {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const openFolders = useMemo(() => unfoldedOf(ui, OPENED.folders), [ui]);
  const dirty = useMemo(() => new Set(Object.keys(state.drafts)), [state.drafts]);
  return (
    <FileTreePanel
      tree={state.tree}
      selected={state.doc ? { layer: state.doc.layer, path: state.doc.path, ...(state.doc.project !== undefined ? { project: state.doc.project } : {}) } : null}
      dirty={dirty}
      expanded={openFolders}
      onToggleExpanded={(key) => actions.toggleUnfolded(OPENED.folders, key)}
      onSelect={actions.selectFile}
      onCreate={actions.createWorkflow}
      onCreateFile={actions.createFile}
      find={find}
      draft={draft}
      onDraft={onDraft}
      onUnfold={(keys) => actions.unfold(OPENED.folders, keys)}
      project={state.at}
    />
  );
}
