import { useEffect, useMemo, useRef, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { publishUsageFigures, useNow } from "@jaira/ui/limitsStore";
import { noticeToShow } from "@jaira/ui/noticesModel";
import { useNotices } from "@jaira/ui/noticesStore";
import { hueOf } from "@jaira/ui/pillModel";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { invoke, subscribe, useApp } from "@jaira/ui/store";
import { ReadOnlyJudgeContext, WorkLookContext, forgetReadOnly, readOnlyJudgeOf } from "@jaira/ui/workSummaryContext";
import { FOLD, PANE, openOf, paneDefault, paneOf } from "@jaira/ui/uiState";
import { MessageTypeContext, type MessageTypeStore } from "@jaira/ui/messageTypes";
import { PANEL_FOLD, roomOf } from "@jaira/ui/panelHost";
import { push } from "@jaira/ui/panelStack";
import { windowTitle } from "@jaira/ui/shellModel";
import { phoneTypography } from "@jaira/ui/phoneModel";
import { ValuePanelContext, type PinnedValue, type ValuePanel } from "@jaira/ui/valuePanel";
import { panelOnStack } from "../components/panel/panelBridge";
import { InboxStrip } from "../components/InboxStrip";
import { Splitter } from "../components/files/Splitter";
import { CrashBoundary, LooseErrorBanner } from "../components/floats/CrashScreen";
import { Disconnected } from "../components/floats/Disconnected";
import { ShellFloats } from "../components/floats/ShellFloats";
import { edge, landmark } from "../primitives";
import { TokenRoot, useLook, useTokens } from "../tokens";
import { TouchRoot, shellTouch } from "../touchElsewhere";
import { BoardColumn } from "./BoardColumn";
import { ChatView } from "./ChatView";
import { DebugView } from "./DebugView";
import { FilesView } from "./FilesView";
import { GalleryView } from "./GalleryView";
import { LogsView } from "./LogsView";
import { PanelColumn } from "./PanelColumn";
import { SettingsView } from "./SettingsView";
import { AppContext, useShell } from "./shell";
import { PhoneContext } from "./phone";
import { PhoneFrame, RemoteLine } from "./PhoneFrame";
import { ShellSidebar } from "./SidebarRegion";
import { ShellTitleBar } from "./TitleBar";
import { pageGround, usePageRules, useWindowTitle } from "./windowPage";

/**
 * The shell (decision 0015): the app's one frame, drawn by the desktop's window and a browser through
 * react-native-web and natively by a phone. One store drives it — `useApp()`, called once, here — and
 * every region reads it through `useShell`. Every `View` has a room here.
 *
 * `phone`: the host is a phone's window (decision 0015, amended 2026-10-04) — the shell lays itself out
 * for it (`PhoneFrame`), and its text is larger (`phoneModel.ts`' `phoneTypography`).
 */
export function UniversalApp({ phone = false }: { phone?: boolean } = {}): JSX.Element {
  const model = useApp();
  const { state } = model;
  // What every transcript is provided, however deep: how work between two messages is summarised
  // (the person's Appearance → Conversation), and the read-only judge that names a phase Changed —
  // asked of the project the window stands on, forgotten when a permission set changes.
  const look = useMemo(() => lookOf(state.config), [state.config]);
  const { workPhases, workRows, workThinking, workNotes } = look.conversation;
  const workLook = useMemo(() => ({ phases: workPhases, rows: workRows, thinking: workThinking, notes: workNotes }), [workPhases, workRows, workThinking, workNotes]);
  // How an account's usage is drawn, for every figure the setting governs (`limitsStore.ts`):
  // unpublished, every figure stays at the default whatever Appearance says.
  useEffect(() => publishUsageFigures(look.conversation.usageFigures), [look.conversation.usageFigures]);
  const readOnlyJudge = useMemo(() => readOnlyJudgeOf((calls) => invoke("permissionSets:judgeReadOnly", { project: state.at ?? SHARED_SESSION, calls })), [state.at]);
  useEffect(() => subscribe((message) => void (message.type === "store:invalidate" && message.scope === "workflows" && forgetReadOnly(readOnlyJudge))), [readOnlyJudge]);
  const { actions } = model;
  // Where a reader's "no, this message is markdown" is kept (`messageTypes.ts`): `ui.modes`, so a reading
  // switched in a message survives a reload — and cleared by writing "".
  const ui = state.settings.ui;
  const messageTypes = useMemo<MessageTypeStore>(
    () => ({
      get: (key) => {
        const held = ui.modes[key];
        return held === undefined || held === "" ? undefined : held;
      },
      set: (key, mime) => actions.setMode(key, mime ?? ""),
    }),
    [ui, actions],
  );
  // "Open in context panel" from any value (`valuePanel.ts`): PUSHED on the room's stack, which
  // the panel column holds (`panelBridge.ts`), and the panel unfolds.
  const at = useRef({ view: state.view, project: state.selectedProject ?? state.at });
  at.current = { view: state.view, project: state.selectedProject ?? state.at };
  const valuePanel = useMemo<ValuePanel>(() => {
    const unfold = (): void => {
      const room = roomOf(at.current.view);
      if (room !== null) actions.setFold(PANEL_FOLD[room], true);
    };
    return {
      open: (item: PinnedValue) => {
        panelOnStack.get()?.((was) => push(was, { kind: "preview", key: `preview:${item.title}`, preview: item }));
        unfold();
      },
      openState: (stateId: string) => {
        const project = at.current.project;
        panelOnStack.get()?.((was) => push(was, { kind: "state", key: `state:${project ?? ""}:${stateId}`, stateId, project, tab: "configuration" }));
        unfold();
      },
    };
  }, [actions]);
  const appearance = useMemo(() => (phone ? { ...model.appearance, overrides: phoneTypography(model.appearance.overrides) } : model.appearance), [phone, model.appearance]);
  return (
    <PhoneContext.Provider value={phone}>
    <AppContext.Provider value={model}>
      <ValuePanelContext.Provider value={valuePanel}>
        <MessageTypeContext.Provider value={messageTypes}>
          <WorkLookContext.Provider value={workLook}>
            <ReadOnlyJudgeContext.Provider value={readOnlyJudge}>
              <TokenRoot {...appearance}>
                <CrashBoundary>
                  <TouchRoot>
                    {phone ? <PhoneFrame /> : <Frame />}
                  </TouchRoot>
                </CrashBoundary>
                {/* Outside the boundary: a report about a failure must not go down with what it
                    reports. After the frame, so a phone draws them over it. */}
                <Disconnected />
                <LooseErrorBanner />
              </TokenRoot>
            </ReadOnlyJudgeContext.Provider>
          </WorkLookContext.Provider>
        </MessageTypeContext.Provider>
      </ValuePanelContext.Provider>
    </AppContext.Provider>
    </PhoneContext.Provider>
  );
}

/**
 * The frame: the sidebar, its splitter, and the body — a row the height of the window. The body is the
 * address bar over the viewport, and the inbox strip under both. Each region is a file of its own
 * (`SidebarRegion.tsx`, `TitleBar.tsx`, `BoardColumn.tsx`, `PanelColumn.tsx`, and a file per room:
 * `FilesView.tsx`, `ChatView.tsx`, `SettingsView.tsx`, …).
 */
function Frame(): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const { state, actions } = useShell();
  // The window's name outside the window (`shellModel.ts`' `windowTitle`), and the page's own rules — the
  // keyboard's focus ring, the one scrollbar. Web only; a phone has neither.
  useWindowTitle(windowTitle(state.at, state.view, state.doc?.path ?? state.dir?.path ?? null));
  usePageRules(t);
  return (
    // The window's ground (--bg) is the page's own canvas on web (`usePageRules` gives it to `body`); a
    // phone paints it here. Positioned on web, so it is the box of last resort for whatever is placed
    // absolutely with no positioned box nearer (a hidden probe measuring a table's columns): it clips,
    // where the page itself would grow a scrollbar and lay the whole window out ten pixels narrower.
    <View flex={1} flexDirection="row" overflow="hidden" {...((isWeb ? { position: "relative" } : {}) as object)} {...((pageGround(t) ? {} : { backgroundColor: t.v("bg") }) as object)} {...(shellTouch as object)}>
      <ShellSidebar />
      {/* The sidebar's splitter: a drag writes `PANE.shellSidebar` (180–520). None on a collapsed
          sidebar: the rail is a fixed strip of glyphs. */}
      {openOf(state.settings.ui, FOLD.shellSidebar) ? (
        <Splitter
          label="Resize the sidebar"
          value={paneOf(state.settings.ui, PANE.shellSidebar)}
          reset={paneDefault(PANE.shellSidebar)}
          min={180}
          max={520}
          onChange={(size) => actions.setPane(PANE.shellSidebar, size)}
        />
      ) : null}
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column">
        {/* The title bar: at least 34 tall, --panel, a --line under it — 1.5px of --rule under the
            contrast palette, a --rule under blueprint. */}
        <View
          {...(landmark("banner") as object)}
          flexDirection="row"
          alignItems="stretch"
          flexShrink={0}
          minHeight={34}
          backgroundColor={t.v("panel") as never}
          {...(edge(t, { bottom: look.palette === "contrast" ? 1.5 : 1 }, look.palette === "contrast" || look.palette === "blueprint" ? "rule" : "line") as object)}
        >
          <ShellTitleBar />
        </View>
        {/* A phone's machine while none is reached (a tablet draws this frame): nothing on the desktop. */}
        <RemoteLine />
        {/* The viewport: the open room, taking the rest of the height. */}
        <View flex={1} minHeight={0} flexDirection="row">
          {state.view === "tasks" ? (
            <>
              <View flex={1} minWidth={0} minHeight={0}>
                <BoardColumn />
              </View>
              <PanelColumn />
            </>
          ) : state.view === "files" ? (
            <FilesView />
          ) : state.view === "chat" ? (
            <ChatView />
          ) : state.view === "settings" ? (
            <SettingsView />
          ) : state.view === "logs" ? (
            <LogsView />
          ) : state.view === "debug" ? (
            <DebugView />
          ) : state.view === "gallery" ? (
            <GalleryView />
          ) : null}
        </View>
        <ShellInbox />
      </View>
      {/* The dialogs the shell raises on its own, over any room: module and orphan approvals, the init prompt. */}
      <ShellFloats />
    </View>
  );
}

/** The inbox strip on the store: what is awaiting the person across projects, and the one notice to show. */
export function ShellInbox(): JSX.Element | null {
  const { state, actions } = useShell();
  const projectHues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  const notices = useNotices();
  const now = useNow(30_000);
  const shownNotice = useMemo(
    () => noticeToShow(notices, state.settings.ui.noticesRead, (project) => project === SHARED_SESSION || state.projects.some((p) => p.project === project)),
    [notices, state.settings.ui.noticesRead, state.projects],
  );
  return (
    <InboxStrip
      pending={state.pending}
      approvals={state.approvals}
      questions={state.questions}
      projects={state.projects}
      hues={projectHues}
      onSelect={(taskId, project) => {
        actions.setView("tasks");
        actions.select(taskId, project);
      }}
      notice={shownNotice}
      now={now}
      onOpenNotice={(notice) => {
        actions.setView("tasks");
        actions.select(notice.taskId, notice.project, notice.stateId ?? null, notice.instanceId ?? null);
        actions.readNotice(notice, notices);
      }}
      onDismissNotice={(notice) => actions.readNotice(notice, notices)}
    />
  );
}
