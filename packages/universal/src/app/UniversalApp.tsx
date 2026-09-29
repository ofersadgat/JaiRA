import { useEffect, useMemo, type JSX } from "react";
import { View } from "@tamagui/core";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { useNow } from "@jaira/ui/limitsStore";
import { noticeToShow } from "@jaira/ui/noticesModel";
import { useNotices } from "@jaira/ui/noticesStore";
import { hueOf } from "@jaira/ui/pill";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { invoke, subscribe, useApp } from "@jaira/ui/store";
import { ReadOnlyJudgeContext, WorkLookContext, forgetReadOnly, readOnlyJudgeOf } from "@jaira/ui/workSummaryContext";
import { FOLD, openOf } from "@jaira/ui/uiState";
import { InboxStrip } from "../components/InboxStrip";
import { ShellFloats } from "../components/floats/ShellFloats";
import { edge } from "../primitives";
import { TokenRoot, useLook, useTokens } from "../tokens";
import { BoardColumn } from "./BoardColumn";
import { ChatView } from "./ChatView";
import { DebugView } from "./DebugView";
import { FilesView } from "./FilesView";
import { GalleryView } from "./GalleryView";
import { LogsView } from "./LogsView";
import { PanelColumn } from "./PanelColumn";
import { SettingsView } from "./SettingsView";
import { AppContext, useShell } from "./shell";
import { ShellSidebar } from "./SidebarRegion";
import { ShellTitleBar } from "./TitleBar";
import { Uncopied } from "./Uncopied";

/**
 * The desktop's shell, universal (decision 0015): `App.tsx`'s frame drawn from copies, on a phone and in
 * the `/rn` page that tests the phone's path in a browser. The same store drives it — `useApp()`, once,
 * here, as `App.tsx` calls it once — so this is a second VIEW of the one state, not a second app.
 *
 * What is not copied yet is drawn as {@link Uncopied}: a labelled box where the region stands, so what is
 * left is visible on the screen and in every gate picture, rather than silently missing.
 */
export function UniversalApp(): JSX.Element {
  const model = useApp();
  const { state } = model;
  // What `App.tsx` provides every transcript, however deep: how work between two messages is summarised
  // (the person's Appearance → Conversation), and the read-only judge that names a phase Changed —
  // asked of the project the window stands on, forgotten when a permission set changes.
  const look = useMemo(() => lookOf(state.config), [state.config]);
  const { workPhases, workRows, workThinking, workNotes } = look.conversation;
  const workLook = useMemo(() => ({ phases: workPhases, rows: workRows, thinking: workThinking, notes: workNotes }), [workPhases, workRows, workThinking, workNotes]);
  const readOnlyJudge = useMemo(() => readOnlyJudgeOf((calls) => invoke("permissionSets:judgeReadOnly", { project: state.at ?? SHARED_SESSION, calls })), [state.at]);
  useEffect(() => subscribe((message) => void (message.type === "store:invalidate" && message.scope === "workflows" && forgetReadOnly(readOnlyJudge))), [readOnlyJudge]);
  return (
    <AppContext.Provider value={model}>
      <WorkLookContext.Provider value={workLook}>
        <ReadOnlyJudgeContext.Provider value={readOnlyJudge}>
          <TokenRoot {...model.appearance}>
            <Frame />
          </TokenRoot>
        </ReadOnlyJudgeContext.Provider>
      </WorkLookContext.Provider>
    </AppContext.Provider>
  );
}

/**
 * `.app`: the sidebar, its splitter, and the body — a row the height of the window. The body is the
 * address bar over the viewport, and the inbox strip under both. Each region is a file of its own
 * (`SidebarRegion.tsx`, `TitleBar.tsx`, `BoardColumn.tsx`, `PanelColumn.tsx`, and a file per room:
 * `FilesView.tsx`, `ChatView.tsx`, `SettingsView.tsx`, …), so copies land side by side.
 */
function Frame(): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const { state } = useShell();
  return (
    <View flex={1} flexDirection="row" overflow="hidden" backgroundColor={t.v("bg") as never}>
      <ShellSidebar />
      {/* `.splitter`: 6 wide, a 2px --line down its middle (`::before`, inset 0 2px). Dragged on the desktop. */}
      {openOf(state.settings.ui, FOLD.shellSidebar) ? (
        <View width={6} flexShrink={0} alignItems="center">
          <View width={2} flex={1} backgroundColor={t.v("line") as never} />
        </View>
      ) : null}
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column">
        {/* `.title-bar`: at least 34 tall, --panel, a --line under it — 1.5px of --rule under contrast, a
            --rule under blueprint (`:root[data-palette=…] .title-bar`). */}
        <View
          flexDirection="row"
          alignItems="stretch"
          flexShrink={0}
          minHeight={34}
          backgroundColor={t.v("panel") as never}
          {...(edge(t, { bottom: look.palette === "contrast" ? 1.5 : 1 }, look.palette === "contrast" || look.palette === "blueprint" ? "rule" : "line") as object)}
        >
          <ShellTitleBar />
        </View>
        {/* `.viewport`: the view, taking the rest of the height. */}
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
          ) : (
            <Uncopied name={`the ${state.view} view`} flex={1} />
          )}
        </View>
        <ShellInbox />
      </View>
      {/* The dialogs `App.tsx` raises on its own, over any room: module and orphan approvals, the init prompt. */}
      <ShellFloats />
    </View>
  );
}

/** The inbox strip, with what `App.tsx` hands its own. */
function ShellInbox(): JSX.Element | null {
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
