import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { drawerSettles } from "@jaira/ui/phoneModel";
import { Animated, PanResponder, Platform, View as RNView, useWindowDimensions } from "react-native";
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
import { remoteStatus } from "./remoteStatus";
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
 * - **the inbox strip** gone: the INBOX row opens the Inbox room (`InboxRoom`) in its place;
 * - **the machine**, while none is connected: a line under the title bar saying so, which opens the
 *   Connect screen (`RemoteLine`). The shell does not wait for a machine to be drawn.
 *
 * The keyboard: the frame stands clear of it, so what is at its foot — a composer, a sheet's field —
 * rides on it (`useKeyboardTop`, on iOS; Android resizes the window for it, `adjustResize`). How it looks:
 *
 *   the title bar   row, at least 44 tall, --panel, a --line under it
 *   ▸|              44 wide, app 13/12.5; the dot 8 round, --warn, 3 after it and 2 above its top
 *   the drawer      the sidebar at 86% of the width (330 at most), sliding in over 180ms; --scrim over the
 *                   rest, as dark as the drawer is out. A swipe right from the screen's left edge (its first
 *                   20) pulls it out under the finger, a swipe left on it pushes it back (`drawerSettles`)
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
      <DrawerHost open={drawer}>
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
      <RemoteLine />
      <View flex={1} minHeight={0} flexDirection="column" {...((isWeb ? { position: "relative" } : {}) as object)}>
        {inbox ? <ShellInboxRoom /> : <Room />}
      </View>
      </DrawerHost>
      <ShellFloats />
    </RNView>
  );
}

/**
 * The phone's machine, while it is not connected (`remoteStatus`): the shell is drawn at once and its
 * projects come with the machine, so this line says why there are none yet — no machine paired, one being
 * reached, one not answering — and opens the Connect screen. How it looks: a row, 40 tall, padding 0 12,
 * gap 8, --panel-2, a --line under it; a dot 8 round (--dim, --accent reaching, --warn not answering), the
 * words app 13/12.5 one line, and Connect / Details app 13/12.5 600 --accent at the end.
 */
export function RemoteLine(): JSX.Element | null {
  const t = useTokens();
  const status = remoteStatus.use();
  if (status === null) return null;
  const words =
    status.state === "none" ? "No machine connected" : status.state === "connecting" ? `Connecting to ${status.label ?? "your machine"}…` : `${status.label ?? "Your machine"}: ${status.detail ?? "not answering"}`;
  return (
    <Press onPress={status.open} label={`${words}. ${status.state === "none" ? "Connect" : "Details"}`} flexShrink={0} height={40} paddingHorizontal={12} flexDirection="row" alignItems="center" gap={8} box={({ pressed }) => ({ backgroundColor: t.v(pressed ? "panel-3" : "panel-2"), ...(edge(t, { bottom: 1 }) as object) })}>
      <View width={8} height={8} borderRadius={4} backgroundColor={t.v(status.state === "problem" ? "warn" : status.state === "connecting" ? "accent" : "dim") as never} />
      <Txt spec={{ voice: "app", scale: 13 / 12.5 }} ellip flex={1} minWidth={0}>
        {words}
      </Txt>
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, color: "accent" }}>{status.state === "none" ? "Connect" : "Details"}</Txt>
    </Press>
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

/**
 * How much of the screen's left edge a swipe that pulls the drawer out starts in. Wider on Android, whose
 * gesture navigation keeps the first 24 or so for its own Back: a swipe from just past that is the
 * drawer's.
 */
const EDGE = Platform.OS === "android" ? 36 : 20;

/**
 * The sidebar, slid over the room from the left — by ▸|, or by a finger from the screen's left edge,
 * following it; a press on the rest closes it, and so does a swipe back to the left.
 */
function DrawerHost({ open, children }: { open: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const width = Math.min(330, Math.round(win.width * 0.86));
  // How far out the drawer is: 0 shut, `width` all the way.
  const out = useRef(new Animated.Value(open ? width : 0)).current;
  const [shown, setShown] = useState(open);
  /** A finger is moving it. */
  const [dragging, setDragging] = useState(false);
  const live = useRef({ width, open });
  live.current = { width, open };
  const animate = (to: number, done?: () => void): void => {
    Animated.timing(out, { toValue: to, duration: 180, useNativeDriver: !isWeb }).start(({ finished }) => {
      if (finished) done?.();
    });
  };
  // Opened or closed by the store (▸|, a choice made in it): slid in, or out and then gone — gone after the
  // slide's time whether or not the slide says it finished, since one that is cut short says it did not,
  // and a drawer left standing at nothing would still take every touch.
  useEffect(() => {
    if (open) {
      setShown(true);
      animate(width);
      return undefined;
    }
    animate(0, () => setShown(false));
    const gone = setTimeout(() => setShown(false), 260);
    return () => clearTimeout(gone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Where the touch began: a pan's own start is not known until it is granted, and the edge is asked before.
  const began = useRef(Number.POSITIVE_INFINITY);
  /** A drag that moves the drawer: from where it stood, settled by `drawerSettles`. */
  const dragger = (from: () => number) => {
    let start = 0;
    return {
      onPanResponderGrant: () => {
        start = from();
        setShown(true);
        setDragging(true);
      },
      onPanResponderMove: (_e: unknown, g: { dx: number }) => out.setValue(Math.max(0, Math.min(live.current.width, start + g.dx))),
      onPanResponderRelease: (_e: unknown, g: { dx: number; vx: number }) => {
        setDragging(false);
        const opened = drawerSettles(start + g.dx, g.vx, live.current.width);
        if (opened) {
          animate(live.current.width);
          phoneDrawer.set(true);
        } else if (live.current.open) phoneDrawer.set(false);
        else {
          animate(0, () => setShown(false));
          setTimeout(() => setShown(live.current.open), 260);
        }
      },
      onPanResponderTerminationRequest: () => false,
    };
  };
  const edge = useMemo(
    () =>
      PanResponder.create({
        // Asked of every drag before what is under it, and taken only from the screen's left edge going
        // right: a tap, and every other drag, are left to what is under the finger.
        onStartShouldSetPanResponderCapture: (e) => {
          began.current = e.nativeEvent.pageX;
          return false;
        },
        onMoveShouldSetPanResponderCapture: (_e, g) => !live.current.open && began.current < EDGE && g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        ...dragger(() => 0),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const back = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        ...dragger(() => live.current.width),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const close = (): void => phoneDrawer.set(false);
  const slide = out.interpolate({ inputRange: [0, Math.max(1, width)], outputRange: [-width, 0], extrapolate: "clamp" });
  const dim = out.interpolate({ inputRange: [0, Math.max(1, width)], outputRange: [0, 1], extrapolate: "clamp" });
  return (
    <>
      <RNView {...edge.panHandlers} style={{ flex: 1, minHeight: 0 }}>
        {children}
      </RNView>
      {shown ? (
        // Shut, it takes no touch while it slides away.
        <RNView {...back.panHandlers} pointerEvents={open || dragging ? "auto" : "none"} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, flexDirection: "row", zIndex: 50 }}>
          <Animated.View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: dim }}>
            <Press onPress={close} label="Close the sidebar" position="absolute" top={0} left={0} right={0} bottom={0} box={() => ({ backgroundColor: t.v("scrim") })} />
          </Animated.View>
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
      ) : null}
    </>
  );
}
