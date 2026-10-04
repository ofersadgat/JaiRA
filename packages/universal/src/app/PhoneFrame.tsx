import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Animated, Platform, View as RNView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { inboxItemsOf } from "@jaira/ui/inboxModel";
import { awaitingCount } from "@jaira/ui/noticesModel";
import { hueOf } from "@jaira/ui/pillModel";
import { windowTitle } from "@jaira/ui/shellModel";
import { InboxRoom } from "../components/InboxRoom";
import { Pill } from "../components/Pill";
import { ShellFloats } from "../components/floats/ShellFloats";
import { useKeyboardTop } from "../components/floats/keyboard";
import { Press, Txt, edge, landmark } from "../primitives";
import { useLook, useTokens } from "../tokens";
import { shellTouch } from "../touchElsewhere";
import { BoardColumn } from "./BoardColumn";
import { ChatView } from "./ChatView";
import { DebugView } from "./DebugView";
import { FilesView } from "./FilesView";
import { GalleryView } from "./GalleryView";
import { LogsView } from "./LogsView";
import { PanelColumn } from "./PanelColumn";
import { SettingsView } from "./SettingsView";
import { useShell } from "./shell";
import { ShellSidebar } from "./SidebarRegion";
import { ShellTitleBar } from "./TitleBar";
import { phoneDrawer, phoneInbox, sheetAsk } from "./viewState";
import { pageGround, usePageRules, useWindowTitle } from "./windowPage";

/**
 * The frame on a phone (decision 0015, amended 2026-10-04: the mobile pass). The desktop's regions, each
 * where a phone has room for it:
 *
 * - **the title bar** on top, as on the desktop, with the sidebar's ▸| at its start — a dot on it while
 *   something waits for the person;
 * - **the room** under it, the whole width;
 * - **the sidebar** a drawer slid over the room from the left, the same column (`ShellSidebar`), with an
 *   INBOX row at its root beside All tasks and All conversations; a choice in it closes it, as does a
 *   press on what it covers;
 * - **the context panel** a sheet over the room (`PanelColumn` → `PanelSheet`);
 * - **the inbox strip** gone: the INBOX row opens the Inbox room (`InboxRoom`) in its place.
 *
 * The keyboard: the frame stands clear of it, so what is at its foot — a composer, a sheet's field —
 * rides on it (`useKeyboardTop`, on iOS; Android resizes the window for it, `adjustResize`). How it looks:
 *
 *   the title bar   row, at least 44 tall, --panel, a --line under it
 *   ▸|              44 wide, app 13/12.5; the dot 8 round, --warn, 3 after it and 2 above its top
 *   the drawer      the sidebar at 86% of the width (330 at most), sliding in over 180ms; --scrim over the rest
 */
export function PhoneFrame(): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const { state } = useShell();
  useWindowTitle(windowTitle(state.at, state.view, state.doc?.path ?? state.dir?.path ?? null));
  usePageRules(t);
  const drawer = phoneDrawer.use();
  const inbox = phoneInbox.use();
  const awaiting = awaitingCount(state);
  // A choice made — a conversation, a file, a task, a Settings page, a run walked into — closes the drawer.
  useEffect(() => phoneDrawer.set(false), [state.chat.taskId, state.doc?.path, state.selected, state.section, state.trail.length]);
  // The keyboard's cover over the frame's foot, which the frame stands clear of.
  const frame = useRef<RNView>(null);
  const keyboardTop = useKeyboardTop();
  const [cover, setCover] = useState(0);
  useEffect(() => {
    // Android resizes the window for its keyboard (`adjustResize`): there is nothing to stand clear of.
    if (keyboardTop === null || Platform.OS !== "ios") return setCover(0);
    frame.current?.measureInWindow((_x, y, _w, h) => setCover(Math.max(0, y + h - keyboardTop)));
  }, [keyboardTop]);
  return (
    <RNView ref={frame} style={{ flex: 1, paddingBottom: cover, ...(pageGround(t) ? {} : { backgroundColor: t.v("bg") as string }), ...(isWeb ? { position: "relative", overflow: "hidden" } : {}) }} {...(shellTouch as object)}>
      <View
        {...(landmark("banner") as object)}
        flexDirection="row"
        alignItems="stretch"
        flexShrink={0}
        minHeight={44}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { bottom: look.palette === "contrast" ? 1.5 : 1 }, look.palette === "contrast" || look.palette === "blueprint" ? "rule" : "line") as object)}
      >
        <Press onPress={() => phoneDrawer.set(true)} label="Open the sidebar" title="open the sidebar" width={44} flexShrink={0} alignItems="center" justifyContent="center" position="relative">
          <View flexDirection="row" alignItems="flex-start">
            <Txt spec={{ voice: "app", scale: 13 / 12.5, ls: -0.05 }}>▸|</Txt>
            {awaiting > 0 && !inbox ? <View width={8} height={8} marginLeft={3} marginTop={-2} borderRadius={4} backgroundColor={t.v("warn") as never} /> : null}
          </View>
        </Press>
        {inbox ? <InboxTitle n={awaiting} /> : <ShellTitleBar />}
      </View>
      <View flex={1} minHeight={0} flexDirection="column" {...((isWeb ? { position: "relative" } : {}) as object)}>
        {inbox ? <ShellInboxRoom /> : <Room />}
      </View>
      {drawer ? <Drawer /> : null}
      <ShellFloats />
    </RNView>
  );
}

/** The open room, the whole width. In Tasks the board, with the context panel as a sheet over it. */
function Room(): JSX.Element | null {
  const { state } = useShell();
  if (state.view === "tasks") {
    return (
      <>
        <View flex={1} minWidth={0} minHeight={0}>
          <BoardColumn />
        </View>
        <PanelColumn />
      </>
    );
  }
  if (state.view === "files") return <FilesView />;
  if (state.view === "chat") return <ChatView />;
  if (state.view === "settings") return <SettingsView />;
  if (state.view === "logs") return <LogsView />;
  if (state.view === "debug") return <DebugView />;
  if (state.view === "gallery") return <GalleryView />;
  return null;
}

/** The Inbox room's title: its name and how many wait. */
function InboxTitle({ n }: { n: number }): JSX.Element {
  return (
    <View flex={1} flexDirection="row" alignItems="center" gap={8} paddingRight={12} minWidth={0}>
      <Txt register="app-title">Inbox</Txt>
      {n > 0 ? <Pill kind="waiting" n={n} title={`${n} waiting on you`} /> : null}
    </View>
  );
}

/** The Inbox room on the store: a card opens its task, standing on the question at its panel's foot. */
function ShellInboxRoom(): JSX.Element {
  const { state, actions } = useShell();
  const items = useMemo(() => inboxItemsOf(state), [state.pending, state.approvals, state.questions]); // eslint-disable-line react-hooks/exhaustive-deps
  const hues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  return (
    <InboxRoom
      items={items}
      projects={state.projects}
      hues={hues}
      onOpen={(item) => {
        if (item.taskId === undefined) return;
        phoneInbox.set(false);
        actions.setView("tasks");
        actions.select(item.taskId, item.project);
        sheetAsk.set({ detent: "half", at: Date.now() });
      }}
    />
  );
}

/** The sidebar, slid over the room from the left; a press on the rest closes it. */
function Drawer(): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const width = Math.min(330, Math.round(win.width * 0.86));
  const slide = useRef(new Animated.Value(-width)).current;
  useEffect(() => {
    Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: !isWeb }).start();
  }, [slide]);
  const close = (): void => phoneDrawer.set(false);
  return (
    <RNView style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, flexDirection: "row", zIndex: 50 }}>
      <Press onPress={close} label="Close the sidebar" position="absolute" top={0} left={0} right={0} bottom={0} box={() => ({ backgroundColor: t.v("scrim") })} />
      <Animated.View style={{ width, height: "100%", flexDirection: "row", alignItems: "stretch", transform: [{ translateX: slide }], shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 16, elevation: 12 }}>
        <ShellSidebar
          phone={{
            width,
            inbox: phoneInbox.get(),
            onInbox: () => {
              phoneInbox.set(true);
              close();
            },
            onLeaveInbox: () => phoneInbox.set(false),
            // A room chosen is the room to look at: the panel's sheet goes down to its head.
            onRoom: () => sheetAsk.set({ detent: "peek", at: Date.now() }),
            onClose: close,
          }}
        />
      </Animated.View>
    </RNView>
  );
}
