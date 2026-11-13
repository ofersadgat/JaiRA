import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { hueOf } from "@jaira/ui/pillModel";
import { FOOTER_VIEWS, PANEL_VIEWS, ROOT_VIEWS, VIEWS, roomCountsOf, sidebarProjectsOf } from "@jaira/ui/shellModel";
import type { SidebarAct, SidebarView } from "@jaira/ui/sidebarTypes";
import type { View as AppView } from "@jaira/ui/store";
import { newItems, standingRoot, type TreeDraft } from "@jaira/ui/filesModel";
import { FOLD, OPENED, PANE, modeOf, paneOf, unfoldedOf } from "@jaira/ui/uiState";
import { healthCounts, logUnseen } from "@jaira/ui/updatesModel";
import { checkForUpdate, useHealth } from "@jaira/ui/updatesStore";
import { askingTasksOf, groupOf, groupProjects, markAsking, markQueued, mergeBoards } from "@jaira/ui/workspaceGroups";
import { TASK_GROUPS, TASK_GROUP_LABELS, TASK_SORTS, TASK_WHENS, TASK_WHEN_MODE, arrangeTasks, tasksOf } from "@jaira/ui/taskListModel";
import { boardCardOrderOf } from "@jaira/ui/boardModel";
import { openTaskMenu, type BoardMenuHost } from "@jaira/ui/boardMenus";
import type { AskSpec } from "@jaira/ui/menuTypes";
import type { BoardCard } from "@jaira/shared/browser";
import { TaskListPanel } from "../components/tasks/TaskListPanel";
import { AskDialog } from "../components/files/AskDialog";
import { copyText } from "../clipboard";
import { keepDraft } from "@jaira/ui/composerDrafts";
import { homeOf, inScope, machineOf, machinesOf, placesOf, runTargetOf, scopeModes, scopeOf, type Scope, type ScopeMachine } from "@jaira/ui/scopeModel";
import type { RunTarget } from "@jaira/shared/browser";
import { CHAT_GROUPS, CHAT_SORTS, CHAT_WHENS, CHAT_WHEN_MODE, PINNED_MODE, pinnedOf, withPinned, type ChatGroup } from "@jaira/ui/chatListModel";
import { settingsPageProblems } from "@jaira/ui/settingsSections";
import { INBOX_VIEW } from "@jaira/ui/inboxModel";
import { awaitingCount } from "@jaira/ui/noticesModel";
import { fixHealthItem, openHealthPage, useForgeOAuth } from "@jaira/ui/settingsShell";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { FileTreePanel, type FileTreePanelProps } from "../components/files/FileTreePanel";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../components/Menu";
import { Sidebar } from "../components/Sidebar";
import { SettingsSections } from "../components/settings/SettingsSections";
import { ChatListPanel, type ChatArrange } from "../components/chat/ChatListPanel";
import { useChatSurface } from "../components/chat/surface";
import { anchorRectOf } from "../components/floats/anchor";
import { HealthPop } from "../components/floats/HealthCard";
import { FolderBrowser } from "../components/floats/FolderBrowser";
import { useMachines } from "@jaira/ui/machinesModel";
import { UpdateRow } from "../components/floats/UpdateRow";
import { PointerMenus } from "../components/floats/PointerMenus";
import { useShell } from "./shell";
import { useColumnsFit } from "./columnsFit";
import { aboutNotes, splitView } from "./viewState";
import { usePhone } from "./phone";
import { routeOpen, taskPaneEntryOf } from "@jaira/ui/splitModel";
import { phoneMachines } from "./remoteStatus";
import { View } from "@tamagui/core";
import { Press, Txt } from "../primitives";
import { useTokens } from "../tokens";

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
  const fit = useColumnsFit();
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
  /**
   * What the open project's title narrows the panel to (`scopeModel.ts`): kept per project, and the
   * address follows it — a workspace chosen is the one Files and Tasks show; a machine chosen moves off
   * a workspace on another machine; all of them returns to the project's first.
   */
  const group = groupOf(groups, state.at);
  const scope =
    group === undefined || group.members.length < 2
      ? undefined
      : {
          machines: machinesOf(group),
          scope: scopeOf(ui, group),
          onScope: (next: Scope) => {
            for (const [id, mode] of scopeModes(group.key, next)) actions.setMode(id, mode);
            const standing = group.members.find((m) => m.project === state.at);
            const to =
              next.workspace ??
              (next.machine === undefined
                ? group.key
                : standing !== undefined && machineOf(standing) === next.machine
                  ? standing.project
                  : group.members.find((m) => machineOf(m) === next.machine)?.project);
            if (to !== undefined && to !== state.at) actions.standOn(to);
          },
        };
  const find = (id: string): SidebarAct => ({
    id: "find",
    glyph: "⌕",
    label: `find in ${id}`,
    on: finding[id] === true,
    onAct: () => setFinding((f) => ({ ...f, [id]: !(f[id] ?? false) })),
  });
  /** A new conversation, run where `target` says: by default where the title points (`runTargetOf`). */
  const startChat = (target: RunTarget | undefined): void => {
    actions.setView("chat");
    actions.openConversation(null);
    actions.setRunOn(target);
  };
  const scopeTarget = group !== undefined && scope !== undefined ? runTargetOf(group, scope.scope) : undefined;
  const [startMenu, setStartMenu] = useState<MenuAt | null>(null);
  const newChat: SidebarAct = {
    id: "new",
    glyph: "+",
    label: scopeTarget === undefined ? "new conversation" : `new conversation in ${placeLabel(scope)}`,
    onAct: () => startChat(scopeTarget),
    // The other places it could run: every workspace of the project, each under its machine, and
    // wherever there is room. Only for a project of several; one of one has nowhere else.
    ...(scope !== undefined
      ? {
          more: (from: HTMLElement) => {
            const box = anchorBox(from, "More ways to start");
            setStartMenu({
              x: Math.max(4, box.right - MENU_WIDTH),
              y: box.bottom + 4,
              items: [
                { label: "Wherever there is room", checked: scopeTarget === undefined, onSelect: () => startChat(undefined) },
                ...scope.machines.flatMap((m, i) =>
                  m.workspaces.map((w, j) => ({
                    label: `${w.label}`,
                    note: `on ${m.label}${m.state === "online" ? "" : ` · ${m.state}`}`,
                    checked: scopeTarget?.project === w.project,
                    ...(i === 0 && j === 0 ? { separator: true } : {}),
                    onSelect: () => startChat({ project: w.project }),
                  })),
                ),
              ],
            });
          },
        }
      : {}),
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
  /**
   * The Tasks tab's `+`: the project's workflows, to start one (board 31). Choosing one opens its form
   * in the Tasks room, in the workspace the title narrows to. The conversations' and the system's own
   * workflows are not offered: they are not started from here.
   */
  const newTask: SidebarAct = {
    id: "new",
    glyph: "+",
    label: "start a task",
    onAct: (from) => {
      const box = anchorBox(from, "start a task");
      const where = scope?.scope.workspace ?? state.at ?? undefined;
      const roots = state.workflows.filter((w) => !w.rootId.startsWith("chat/") && !w.rootId.startsWith("system/") && w.loadError === undefined);
      setStartMenu({
        x: Math.max(4, box.right - MENU_WIDTH),
        y: box.bottom + 4,
        items:
          roots.length === 0
            ? [{ label: "No workflows to start", disabled: true, onSelect: () => undefined }]
            : roots.map((w) => ({
                label: w.label ?? w.rootId,
                ...(w.label !== undefined ? { note: w.rootId } : {}),
                onSelect: () => {
                  actions.setView("tasks");
                  actions.selectWorkflow(w.rootId, where);
                },
              })),
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
      ? { ...v, counts: rooms.atTasks, onSeen: () => actions.markSeenAll(rooms.seenAtTasks), acts: [newTask], panel: <TasksDrawer /> }
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
      // Folded as the window has it: by the person, or to keep the room beside it wide enough (`columnsFit.ts`).
      collapsed={phone === undefined ? !fit.sidebar : false}
      onCollapsed={(shut) => (phone !== undefined ? phone.onClose() : actions.setFold(FOLD.shellSidebar, !shut))}
      width={phone?.width ?? paneOf(ui, PANE.shellSidebar)}
      scope={scope}
      projects={sidebarProjectsOf(groups, projectHues, ui.seen, actions.markProjectSeen)}
      at={groupOf(groups, state.at)?.key ?? state.at}
      // A project's tile goes back to where its title was left: the workspace it is narrowed to, or the
      // project's first on the machine it is narrowed to (`scopeModel.ts`), so the address and the title
      // never disagree.
      onProject={(project) => {
        const g = project === null ? undefined : groups.find((x) => x.key === project);
        const kept = g === undefined ? {} : scopeOf(ui, g);
        const to = kept.workspace ?? (kept.machine !== undefined ? g?.members.find((m) => machineOf(m) === kept.machine)?.project : undefined);
        actions.standOn(to ?? project);
      }}
      busy={state.busy}
      theme={appearance.scheme}
      onTheme={actions.setTheme}
      onChooseProject={(mode) => void actions.chooseProject(mode)}
      machines={(machinesView?.machines ?? []).map((m) => ({ id: m.id, label: m.label, online: m.state === "online" }))}
      onBrowse={(machineId, mode) => setBrowsing({ machineId, mode })}
      // The Update row above Settings (`UpdateRow`). It opens About, where a failure or a download is
      // said in full — with the release notes open, from its menu (`aboutNotes`).
      // In the rail (`collapsed`) the Update row; at the panel's foot, a phone's machines.
      update={(collapsed) =>
        collapsed ? (
          <UpdateRow collapsed onOpenAbout={() => openAbout(false)} onNotes={() => openAbout(true)} onRetry={checkForUpdate} />
        ) : phone !== undefined ? (
          <PhoneMachinesRow onOpen={phone.onClose} />
        ) : null
      }
      onProjectSettings={(p) => {
        actions.standOn(p.project);
        actions.setConfigLayer(p.kind === "shared" ? "base" : "project");
        actions.setView("settings");
      }}
    />
    {newMenu !== null ? <ContextMenu anchor={newMenu} onClose={() => setNewMenu(null)} /> : null}
    {startMenu !== null ? <ContextMenu anchor={startMenu} onClose={() => setStartMenu(null)} /> : null}
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
      // A new conversation in this project, the file mentioned in its first message: the words are
      // left as the start page's draft (`chat:new:<project>`, `composerDrafts.ts`), to finish and send.
      onAsk={(path) => {
        if (state.at === null) return;
        keepDraft(`chat:new:${state.at}`, `@${path} `);
        actions.setView("chat");
        actions.openConversation(null);
      }}
      onSetDisabled={(stateId, layer, disabled, project) => void actions.setWorkflowDisabled(stateId, layer, disabled, project)}
      find={find}
      draft={draft}
      onDraft={onDraft}
      floats={floats}
      onUnfold={(keys) => actions.unfold(OPENED.folders, keys)}
      project={state.at}
    />
  );
}

/**
 * The Chat drawer: `ChatListPanel` on the room's surface (`useChatSurface`), arranged as its column head
 * was last left (kept in `modes`, one arrangement for every project). Inside a project of several
 * workspaces it can group by workspace, unless the title has narrowed it to one.
 */
function ChatDrawer({ find }: { find: boolean }): JSX.Element {
  const { state, actions } = useShell();
  const phone = usePhone();
  const surface = useChatSurface();
  const ui = state.settings.ui;
  const group = groupOf(groupProjects(state.projects, ui.groupWorkspaces !== false), state.at);
  const scope = group === undefined ? {} : scopeOf(ui, group);
  const several = group !== undefined && group.members.length > 1 && scope.workspace === undefined;
  const groups: ChatGroup[] = several ? [...CHAT_GROUPS] : CHAT_GROUPS.filter((g) => g !== "workspace");
  const arrange: ChatArrange = {
    group: modeOf(ui, CHAT_GROUP_MODE, groups, "none"),
    sort: modeOf(ui, CHAT_SORT_MODE, CHAT_SORTS, "when-desc"),
    groups,
    home: group === undefined ? "" : homeOf(group, scope),
    onGroup: (g) => actions.setMode(CHAT_GROUP_MODE, g),
    onSort: (s) => actions.setMode(CHAT_SORT_MODE, s),
    when: modeOf(ui, CHAT_WHEN_MODE, CHAT_WHENS, "message"),
    onWhen: (w) => actions.setMode(CHAT_WHEN_MODE, w),
    pinned: pinnedOf(ui.modes[PINNED_MODE]),
    onPin: (taskId, on) => actions.setMode(PINNED_MODE, withPinned(ui.modes[PINNED_MODE], taskId, on)),
    onMarkUnread: (taskId) => actions.markUnread([taskId]),
    // A waiting conversation can be sent to any other workspace of its project (`placement:runOn`).
    runOn: (task) =>
      group === undefined
        ? []
        : machinesOf(group).flatMap((m) =>
            m.workspaces
              .filter((w) => w.project !== task.project)
              .map((w) => ({ label: w.label, note: `on ${m.label}`, onSelect: () => void actions.runQueuedOn(task.taskId, task.project ?? group.key, w.project) })),
          ),
  };
  // A row lands in the focused pane (decision 0025): on the right pane's path while that is focused.
  const routed = { ...surface, onOpen: (taskId: string | null, project?: string) => (taskId !== null && openInFocusedPane(taskId, project, phone)) || surface.onOpen(taskId, project) };
  return <ChatListPanel surface={routed} find={find} arrange={arrange} />;
}

/** A conversation or task pressed in the sidebar, onto the right pane's path when that pane is focused; false when the left takes it. */
function openInFocusedPane(taskId: string, project: string | undefined, phone: boolean): boolean {
  const next = routeOpen(splitView.get(), taskPaneEntryOf(taskId, project), phone);
  if (next === null) return false;
  splitView.set(next);
  return true;
}

/**
 * The Tasks drawer (the sidebar mockups, boards 39, 44, 47): the project's tasks — the board's cards,
 * its workspaces merged and every one waiting on the person marked, as the Tasks room draws them — in
 * the machine or workspace the title narrows to, under the column head. A row opens its task in the
 * Tasks room; its ⋯ (or right-click) is the board card's own menu; Stop cancels it.
 */
function TasksDrawer(): JSX.Element {
  const { state, actions } = useShell();
  const phone = usePhone();
  const ui = state.settings.ui;
  const group = groupOf(groupProjects(state.projects, ui.groupWorkspaces !== false), state.at);
  const scope = group === undefined ? {} : scopeOf(ui, group);
  const asking = useMemo(() => askingTasksOf(state.pending, state.approvals, state.questions), [state.pending, state.approvals, state.questions]);
  const cards = useMemo(() => {
    if (group === undefined) return [];
    const board = markAsking(markQueued(mergeBoards(group, state.boards), state.queue), asking);
    return tasksOf(boardCardOrderOf(board)).filter((c) => inScope(group, scope, c.project ?? group.key));
  }, [group, state.boards, state.queue, asking, scope]);
  const several = group !== undefined && group.members.length > 1 && scope.workspace === undefined;
  const groups = several ? [...TASK_GROUPS] : TASK_GROUPS.filter((g) => g !== "workspace");
  const groupBy = modeOf(ui, TASK_GROUP_MODE, groups, "status");
  const sort = modeOf(ui, TASK_SORT_MODE, TASK_SORTS, "when-desc");
  const when = modeOf(ui, TASK_WHEN_MODE, TASK_WHENS, "activity");
  const places = group === undefined ? {} : placesOf(group, scope);
  const sections = arrangeTasks(cards, { group: groupBy, sort, when }, { placeOf: (c) => (c.project === undefined ? undefined : places[c.project]), home: group === undefined ? "" : homeOf(group, scope) });
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const host: BoardMenuHost<{ x: number; y: number }> = {
    actions,
    boards: state.boards,
    queue: state.queue,
    picked: null,
    setPicked: () => undefined,
    setTaskMenu: setMenu,
    setTaskAsk: setAsk,
    copy: (text) => void copyText(text),
  };
  const projectOf = (card: BoardCard): string => card.project ?? group?.key ?? state.at ?? "";
  return (
    <>
      <TaskListPanel
        sections={sections}
        empty={cards.length === 0 && scope.machine !== undefined ? "No tasks here." : "No tasks yet."}
        selected={state.selected}
        head={{
          groups: groups.map((g) => ({ id: g, label: TASK_GROUP_LABELS[g] })),
          group: groupBy,
          onGroup: (g: string) => actions.setMode(TASK_GROUP_MODE, g),
          sort,
          onSort: (s) => actions.setMode(TASK_SORT_MODE, s),
          when,
          onWhen: (w) => actions.setMode(TASK_WHEN_MODE, w),
        }}
        onOpen={(card) => {
          if (openInFocusedPane(card.taskId, projectOf(card), phone)) return;
          actions.setView("tasks");
          actions.select(card.taskId, projectOf(card));
        }}
        onMenu={(card, x, y) => openTaskMenu(host, projectOf(card), card, { x, y })}
        onStop={(card) => void actions.cancelTask(card.taskId, projectOf(card))}
      />
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask !== null ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </>
  );
}

const TASK_GROUP_MODE = "tasks.list.group";
const TASK_SORT_MODE = "tasks.list.sort";
const CHAT_GROUP_MODE = "chat.list.group";
const CHAT_SORT_MODE = "chat.list.sort";

/**
 * A phone's own machines, in its drawer over Update and Settings (decision 0015, amended 2026-10-04): their
 * names and how many answer; pressed, the Connect screen that lists them and pairs another. How it looks:
 * a row 40 tall, padding 0 12, gap 10 — ▣ (--dim), the names (app-label, one line), "n of m" (--dim).
 */
function PhoneMachinesRow({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const t = useTokens();
  const machines = phoneMachines.use();
  if (machines === null) return null;
  const names = machines.labels.length === 0 ? "Connect a machine" : machines.labels.join(", ");
  return (
    <Press
      onPress={() => {
        onOpen();
        machines.open();
      }}
      label={`This phone's machines: ${names}`}
      height={40}
      paddingHorizontal={12}
      flexDirection="row"
      alignItems="center"
      gap={10}
      borderRadius={6}
      box={({ pressed }) => ({ backgroundColor: pressed ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>▣</Txt>
      <View flex={1} minWidth={0}>
        <Txt register="app-label" ellip>
          {names}
        </Txt>
      </View>
      {machines.labels.length > 0 ? <Txt spec={{ voice: "app", scale: 0.92, color: machines.connected > 0 ? "dim" : "warn" }}>{`${machines.connected} of ${machines.labels.length}`}</Txt> : null}
    </Press>
  );
}

/** What the title's narrowing is called on the `+`: its workspace and machine, or its machine. */
function placeLabel(scope: { machines: readonly ScopeMachine[]; scope: Scope } | undefined): string {
  const machine = scope?.machines.find((m) => m.id === scope.scope.machine);
  const workspace = machine?.workspaces.find((w) => w.project === scope?.scope.workspace);
  return workspace !== undefined ? `${workspace.label} on ${machine!.label}` : (machine?.label ?? "this project");
}