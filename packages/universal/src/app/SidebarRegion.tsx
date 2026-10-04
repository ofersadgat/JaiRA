import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { hueOf } from "@jaira/ui/pillModel";
import { FOOTER_VIEWS, PANEL_VIEWS, ROOT_VIEWS, VIEWS, roomCountsOf, sidebarProjectsOf } from "@jaira/ui/shellModel";
import type { SidebarAct, SidebarView } from "@jaira/ui/sidebarTypes";
import type { View as AppView } from "@jaira/ui/store";
import { newItems, standingRoot, type TreeDraft } from "@jaira/ui/filesModel";
import { FOLD, OPENED, PANE, openOf, paneOf, unfoldedOf } from "@jaira/ui/uiState";
import { healthCounts, logUnseen } from "@jaira/ui/updatesModel";
import { checkForUpdate, useHealth } from "@jaira/ui/updatesStore";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { settingsPageProblems } from "@jaira/ui/settingsSections";
import { INBOX_VIEW } from "@jaira/ui/inboxModel";
import { awaitingCount } from "@jaira/ui/noticesModel";
import { fixHealthItem, openHealthPage, useForgeOAuth } from "@jaira/ui/settingsShell";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { FileTreePanel, type FileTreePanelProps } from "../components/files/FileTreePanel";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../components/Menu";
import { Sidebar } from "../components/Sidebar";
import { SettingsSections } from "../components/settings/SettingsSections";
import { ChatListPanel } from "../components/chat/ChatListPanel";
import { useChatSurface } from "../components/chat/surface";
import { anchorRectOf } from "../components/floats/anchor";
import { HealthPop } from "../components/floats/HealthCard";
import { FolderBrowser } from "../components/floats/FolderBrowser";
import { useMachines } from "@jaira/ui/machinesModel";
import { UpdateRow } from "../components/floats/UpdateRow";
import { PointerMenus } from "../components/floats/PointerMenus";
import { useShell } from "./shell";
import { aboutNotes } from "./viewState";

/**
 * The sidebar as a phone's drawer (`PhoneFrame`): its width, the Inbox room it opens from an INBOX row at
 * its root, and closing it — its own |◂, and any row that has no drawer of its own to show.
 */
export type PhoneSidebar = {
  width: number;
  inbox: boolean;
  onInbox: () => void;
  onLeaveInbox: () => void;
  /** A room was chosen (not the Inbox). */
  onRoom: () => void;
  onClose: () => void;
};

/**
 * The sidebar on the store: the rooms, their counts (`shellModel.ts`), their verbs, and the drawers each
 * opens onto — with the floats its rows raise: the `+` menu, the health card, the folder browser. On a
 * phone (`phone`) it is a drawer, with the Inbox's row at its root.
 */
export function ShellSidebar({ phone }: { phone?: PhoneSidebar | undefined } = {}): JSX.Element {
  const { state, actions, appearance } = useShell();
  const ui = state.settings.ui;
  const health = useHealth();
  /**
   * Settings' warnings and errors: the card the Settings and Logs rows' pills open, placed beside the
   * pills pressed — and what each item's button does (`settingsShell.ts`).
   */
  /** The paired machines, and the one being browsed for a project to open or make. */
  const [machinesView] = useMachines();
  const [browsing, setBrowsing] = useState<{ machineId: string; mode: "open" | "init" } | null>(null);
  const [healthAt, setHealthAt] = useState<{ at: FloatRect | null } | null>(null);
  const openHealthCard = (from: unknown): void => setHealthAt((was) => (was !== null ? null : { at: anchorRectOf(from, "What needs attention") }));
  // Emptied — dismissed or cleared by itself — the card has nothing to be placed against: its pills are gone.
  useEffect(() => {
    if (health.length === 0) setHealthAt(null);
  }, [health.length]);
  const forgeOAuth = useForgeOAuth(state.availability.forges, actions.readAvailability);
  // About, opened from the Update row — with the release notes showing, from its menu. Only for the
  // one opening: About opened from its list later starts with them folded.
  useEffect(() => {
    if (state.view !== "settings" || state.section !== "about") aboutNotes.set(false);
  }, [state.view, state.section]);
  const openAbout = (notes: boolean): void => {
    aboutNotes.set(notes);
    actions.setSection("about");
    actions.setView("settings");
  };
  /**
   * The room Settings was entered FROM, which is where leaving it goes — never a view inside the
   * settings panel (Logs, Debug, Components), or the way out would lead back in.
   */
  const beforeSettings = useRef<AppView>("files");
  useEffect(() => {
    if (!PANEL_VIEWS.has(state.view)) beforeSettings.current = state.view;
  }, [state.view]);
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
   * The `+` on the Files row: the menu it drops, and the row in the tree it starts — held here because
   * the row and the drawer are both this region's.
   */
  // The tree's own right-click menus are drawn here too: outside the sidebar, in the window's tokens.
  const [newMenu, setNewMenu] = useState<MenuAt | null>(null);
  const [newDraft, setNewDraft] = useState<TreeDraft | null>(null);
  const newFile: SidebarAct = {
    id: "new",
    glyph: "+",
    label: "new file, folder or workflow",
    onAct: (from) => {
      const root = standingRoot(state.tree, state.at);
      if (root === null) return;
      // Right-aligned under the button: hung off the far end of the column, a menu has nowhere to go
      // but back over it.
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
  const inboxRoot: SidebarView[] = phone === undefined ? [] : [{ ...INBOX_VIEW, counts: { waiting: awaitingCount(state) } }];
  const roots: SidebarView[] = [...inboxRoot, ...ROOT_VIEWS.map((v): SidebarView =>
    v.id !== "chat"
      ? { ...v, counts: rooms.rootTasks, onSeen: () => actions.markSeenAll(rooms.seenRootTasks) }
      : {
          ...v,
          counts: rooms.rootChat,
          onSeen: () => actions.markSeenAll(rooms.seenRootChat),
          acts: [{ ...newChat, onAct: (from) => (actions.standOn(null), newChat.onAct(from)) }, find("conversations")],
          panel: <ChatDrawer find={finding.conversations === true} />,
        },
  )];
  const views: SidebarView[] = VIEWS.map((v) =>
    v.id === "tasks"
      ? { ...v, counts: rooms.atTasks, onSeen: () => actions.markSeenAll(rooms.seenAtTasks) }
      : v.id === "chat"
        ? { ...v, counts: rooms.atChat, onSeen: () => actions.markSeenAll(rooms.seenAtChat), acts: [newChat, find("chat")], panel: <ChatDrawer find={finding.chat === true} /> }
        : { ...v, acts: [newFile, find("files")], panel: <FilesDrawer find={finding.files === true} draft={newDraft} onDraft={setNewDraft} floats={{ menu: setNewMenu }} /> },
  );
  const footer = FOOTER_VIEWS.map((row) => (row.id === "logs" ? { ...row, counts: logUnseen(health)?.counts ?? {}, onSeen: openHealthCard, seenTitle: "What needs attention" } : row));
  const settings: SidebarView = {
    id: "settings",
    glyph: "⚙",
    label: "Settings",
    counts: healthCounts(health),
    onSeen: openHealthCard,
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
      onLeaveSettings={() => actions.setView(beforeSettings.current)}
      view={phone?.inbox === true ? INBOX_VIEW.id : state.view}
      onView={(id) => {
        if (phone === undefined) return actions.setView(id as AppView);
        if (id === INBOX_VIEW.id) return phone.onInbox();
        phone.onLeaveInbox();
        phone.onRoom();
        actions.setView(id as AppView);
        // A row with a drawer of its own (Files, Chat) stays open on it, to choose from; the rest close.
        if (![...roots, ...views].some((v) => v.id === id && v.panel !== undefined)) phone.onClose();
      }}
      collapsed={phone === undefined ? !openOf(ui, FOLD.shellSidebar) : false}
      onCollapsed={(shut) => (phone !== undefined ? phone.onClose() : actions.setFold(FOLD.shellSidebar, !shut))}
      width={phone?.width ?? paneOf(ui, PANE.shellSidebar)}
      projects={sidebarProjectsOf(groups, projectHues, ui.seen, actions.markProjectSeen)}
      at={groupOf(groups, state.at)?.key ?? state.at}
      onProject={actions.standOn}
      busy={state.busy}
      theme={appearance.scheme}
      onTheme={actions.setTheme}
      onChooseProject={(mode) => void actions.chooseProject(mode)}
      machines={(machinesView?.machines ?? []).map((m) => ({ id: m.id, label: m.label, online: m.state === "online" }))}
      onBrowse={(machineId, mode) => setBrowsing({ machineId, mode })}
      // The Update row above Settings (`UpdateRow`). It opens About, where a failure or a download is
      // said in full — with the release notes open, from its menu (`aboutNotes`).
      update={(collapsed) => <UpdateRow collapsed={collapsed} onOpenAbout={() => openAbout(false)} onNotes={() => openAbout(true)} onRetry={checkForUpdate} />}
      onProjectSettings={(p) => {
        actions.standOn(p.project);
        actions.setConfigLayer(p.kind === "shared" ? "base" : "project");
        actions.setView("settings");
      }}
    />
    {newMenu !== null ? <ContextMenu anchor={newMenu} onClose={() => setNewMenu(null)} /> : null}
    {/* The window's right-click menu for content (web only): mounted with the sidebar, which the shell
        always draws, so it is there once for the window whatever room is open. */}
    <PointerMenus />
    {browsing !== null && machinesView !== undefined ? (
      <FolderBrowser
        machines={machinesView.machines.filter((m) => m.state === "online").map((m) => ({ id: m.id, label: m.label }))}
        initial={browsing.machineId}
        mode={browsing.mode}
        onClose={() => setBrowsing(null)}
        onChosen={(machine, dir) => {
          setBrowsing(null);
          void actions.openOnMachine(machine.id, dir, browsing.mode);
        }}
      />
    ) : null}
    {healthAt !== null ? (
      <HealthPop
        anchor={healthAt.at}
        items={health}
        onClose={() => setHealthAt(null)}
        onFix={(item) => {
          setHealthAt(null);
          fixHealthItem(item, { forgeOAuth, signIn: (name) => void actions.signIn(name), recheck: () => void actions.recheckAvailability(), setView: actions.setView, setSection: actions.setSection });
        }}
        onOpenPage={(page) => {
          setHealthAt(null);
          openHealthPage(page, actions);
        }}
      />
    ) : null}
    </>
  );
}

/**
 * Where the row's `+` stands, for the menu it drops. On web `Sidebar` hands the act its button (the
 * label lookup is a fallback); a phone has no element to hand, and the menu hangs from the top of the
 * column.
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

/** The Files drawer: `FileTreePanel` on the store — the tree, what is open or unsaved, the file verbs. */
function FilesDrawer({ find, draft, onDraft, floats }: { find: boolean; draft: TreeDraft | null; onDraft: (draft: TreeDraft | null) => void; floats: FileTreePanelProps["floats"] }): JSX.Element {
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
      hasProject={state.at !== null}
      onOpen={actions.openWorkflow}
      onMove={actions.moveWorkflow}
      onDelete={actions.deleteWorkflow}
      onRenameFile={actions.renameFile}
      onDeleteFile={actions.deleteFile}
      onReveal={actions.revealFile}
      find={find}
      draft={draft}
      onDraft={onDraft}
      floats={floats}
      onUnfold={(keys) => actions.unfold(OPENED.folders, keys)}
      project={state.at}
    />
  );
}

/** The Chat drawer: `ChatListPanel` on the room's surface (`useChatSurface`). */
function ChatDrawer({ find }: { find: boolean }): JSX.Element {
  return <ChatListPanel surface={useChatSurface()} find={find} />;
}
