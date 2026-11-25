import { useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { layoutPills, type PillCounts } from "@jaira/ui/pillModel";
import type { SidebarAct, SidebarProject, SidebarView } from "@jaira/ui/sidebarTypes";
import { SIDEBAR_RAIL } from "@jaira/ui/uiState";
import { addTargetsOf, addWorkspaceQuestion, crumbFit, machinesWithout, type Scope, type ScopeMachine } from "@jaira/ui/scopeModel";
import { DRAG_REGION, Glyph, NO_DRAG, Press, Txt, edge, landmark, useHover, viewScrollbarProps } from "../primitives";
import { TokenScope, useLook, useTokens, type Tokens } from "../tokens";
import { ContextMenu, type MenuAt } from "./Menu";
import type { MenuItem } from "@jaira/ui/crumbModel";
import { usePhone } from "../app/phone";
import { Pills } from "./Pills";
import { Icon } from "./panel/Icon";
import { TileRing } from "./StatusRing";

/**
 * The one left column (SHELL.md §5.1), a RAIL beside a PANEL (the sidebar mockups, 2026-11-11: the
 * person picked "R2 + R3"). The rail is what is GLOBAL: the root rooms (All tasks, All chats), a tile per
 * project, Open a project, and Settings at its foot — each with its name under it and a badge for the
 * most urgent thing waiting in it. The panel is the project the address stands on, and nothing else:
 * its name, and its rooms as tabs (Files, Tasks, Chat) over the chosen one's drawer. With the address at
 * the root, or Settings open, the panel is that room instead. Which project is open is derived from the
 * address, never stored. Shut, the panel goes and the rail stays, the open project's rooms as small
 * icons under its tile. How it looks:
 *
 *   the column           --sidebar wide plus the rail (the panel's width is the pane), a --line on its
 *                        right; its own variables (`TokenScope`); ground --panel-2, or --chrome under any
 *                        named palette
 *   the rail             `SIDEBAR_RAIL` wide, column, centred, gap 4; --panel-3 (classic) with a --line on
 *                        its right; its head 34 tall (44 on a phone), the window's drag handle, empty
 *                        on the desktop (macOS's window buttons stand there; the toggle leads the
 *                        window's top row), the toggle on a phone
 *   a rail item          `SIDEBAR_RAIL` - 8 wide, radius 8, padding 6 0 5, column, gap 3: its icon (a
 *                        34×30 box) or a project's tile (34 square, radius 10), its name under it (app at
 *                        0.78, --dim; --text and 600 on the one you are on), one line
 *   a badge              over the item's top right: the most urgent pill's count, filled in its colour
 *   the panel            flex 1; its head 40 tall (48 on a phone): the name (data-title), where it is
 *                        (data-faint), the room's verbs (20 square) and ⚙
 *   the tabs             a track of --panel-3, radius 8, padding 2, margin 0 8 8; a tab 26 tall (34 on a
 *                        phone), radius 6; the chosen one --panel with a --line ring; a dot in the colour
 *                        of the most urgent thing in a tab
 *   the drawer           the rest of the height, padding 0 6 6
 */
const ACT_WIDTH = 20;
/** The rail's width, `uiState.ts`'s `SIDEBAR_RAIL`. */
const RAIL = SIDEBAR_RAIL;
const INK: Record<string, string> = { running: "accent", waiting: "warn", error: "bad", warning: "warn", success: "ok" };

/** A colour the host wrote as CSS (`var(--p1)`), as this platform needs it. */
export function colorOf(t: Tokens, css: string): string {
  const name = /^var\(--([\w-]+)(?:,\s*var\(--([\w-]+)\))?\)$/.exec(css.trim());
  if (name === null || !t.replayed) return css;
  const v = t.v(name[1]!);
  return String(v === "" && name[2] !== undefined ? t.v(name[2]) : v);
}

export type SidebarProps = {
  views: readonly SidebarView[];
  roots: readonly SidebarView[];
  footer: readonly SidebarView[];
  settings: SidebarView;
  onLeaveSettings: () => void;
  view: string;
  onView: (id: string) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  projects: readonly SidebarProject[];
  at: string | null;
  onProject: (project: string | null) => void;
  busy: boolean;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onChooseProject: (mode: "open" | "init") => void;
  onProjectSettings: (project: SidebarProject) => void;
  /** A project's own verbs, at the point its tile or its name was right-clicked (held, on a touch screen). */
  onProjectMenu?: (project: SidebarProject, at: { x: number; y: number }) => void;
  /** What stands over Settings in the rail (`true`), and at the panel's foot (`false`). */
  update?: ((collapsed: boolean) => ReactNode) | undefined;
  /** Paired machines a project can be opened or made on (decision 0013 §8). */
  machines?: ReadonlyArray<{ id: string; label: string; online: boolean }>;
  onBrowse?: (machineId: string, mode: "open" | "init") => void;
  /** Open: a project from a forge or a folder on any machine, taken to any machine (decision 0027). */
  onOpenProject?: () => void;
  /** Add a workspace of the open project — on the machine named, or chosen in the full form. */
  onAddWorkspace?: (machineId?: string, at?: { x: number; y: number }) => void;
  /** `--sidebar`: the panel's width while it is open (the rail is beside it). On a phone, the whole drawer's. */
  width: number;
  /**
   * The open project's machines and workspaces, and what its title narrows the panel to
   * (`scopeModel.ts`). Every project has it, however many workspaces: its pill is where one is
   * chosen and where another is added. Absent only outside a project.
   */
  scope?: { machines: readonly ScopeMachine[]; scope: Scope; onScope: (scope: Scope) => void } | undefined;
};

export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <TokenScope scope="sidebar">
      <Column {...props} />
    </TokenScope>
  );
}

/**
 * The sidebar's toggle: `|◂` folds the column to its rail, `▸|` opens it again. 26 square, radius 6, the
 * glyph app at 11 in --dim (--text pointed at, on --fill-ghost-hover); out of the window's drag region. On
 * the desktop it leads the window's top row (`ShellSidebarToggle` in `TitleBar.tsx`); on a phone it stands
 * in the rail's head and closes the drawer.
 */
export function SidebarToggle({ collapsed, onCollapsed }: { collapsed: boolean; onCollapsed: (collapsed: boolean) => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={() => onCollapsed(!collapsed)}
      label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
      title={collapsed ? "show the sidebar" : "hide the sidebar"}
      {...({ "aria-expanded": !collapsed } as object)}
      style={NO_DRAG}
      width={26}
      height={26}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: -0.05, color: hovered ? "text" : "dim" }} whiteSpace="nowrap">
          {collapsed ? "▸|" : "|◂"}
        </Txt>
      )}
    </Press>
  );
}

/** The most urgent of a set of counts, and its colour; `null` when nothing is waiting. */
function worstOf(counts: PillCounts | undefined): { kind: string; n: number | undefined } | null {
  if (counts === undefined) return null;
  const top = layoutPills(counts, 400).fit[0];
  return top === undefined ? null : { kind: top.kind, n: top.n };
}

function Column({
  views,
  roots,
  footer,
  settings,
  onLeaveSettings,
  view,
  onView,
  collapsed,
  onCollapsed,
  projects,
  at,
  onProject,
  busy,
  theme,
  onTheme,
  onChooseProject,
  onProjectSettings,
  onProjectMenu,
  update,
  machines = [],
  onBrowse,
  onOpenProject,
  onAddWorkspace,
  width,
  scope,
}: SidebarProps): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const phone = usePhone();
  const [openMenu, setOpenMenu] = useState<MenuAt | null>(null);
  const named = look.palette !== "classic";
  const ground = named ? t.v("chrome") : t.v("panel-2");
  const settingsOpen = view === settings.id || footer.some((row) => row.id === view);
  const project = at === null ? null : (projects.find((p) => p.project === at) ?? null);
  const rootOn = (v: SidebarView): boolean => view === v.id && (v.keepsProject === true || at === null);
  const goRoot = (v: SidebarView): void => {
    if (at !== null && v.keepsProject !== true) onProject(null);
    onView(v.id);
  };
  const goProject = (p: SidebarProject): void => {
    if (settingsOpen) onLeaveSettings();
    onProject(p.project);
  };
  // On a phone the drawer's width is the whole column; on the desktop the pane is the panel's alone.
  const panelWidth = phone ? Math.max(0, width - RAIL) : width;

  const openProjectMenu = (e: unknown): void => {
    const box = isWeb ? (e as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect() : undefined;
    const touch = (e as { nativeEvent?: { pageX?: number; pageY?: number } }).nativeEvent;
    setOpenMenu({
      x: box !== undefined ? box.right + 4 : (touch?.pageX ?? 0),
      y: box?.top ?? touch?.pageY ?? 0,
      items: [
        // A forge's repository or a folder on any machine, taken to any machine: the Open dialog's places.
        ...(onOpenProject !== undefined
          ? [{ label: "Open project…", note: "forge or machine", onSelect: onOpenProject }, { label: "Open a folder here…", onSelect: () => onChooseProject("open") }]
          : [{ label: "Open project…", onSelect: () => onChooseProject("open") }]),
        { label: "New project…", onSelect: () => onChooseProject("init") },
        ...machines.map((m, i) => ({
          label: `New project on ${m.label}…`,
          ...(i === 0 ? { separator: true } : {}),
          disabled: !m.online,
          ...(m.online ? {} : { note: "offline" }),
          onSelect: () => onBrowse?.(m.id, "init" as const),
        })),
      ],
    });
  };

  const themeRow = (
    <ListRow
      on={false}
      glyph={theme === "dark" ? "☀" : "☾"}
      label={theme === "dark" ? "Light" : "Dark"}
      title={theme === "dark" ? "switch to light" : "switch to dark"}
      onPress={() => onTheme(theme === "dark" ? "light" : "dark")}
    />
  );

  // The room the panel shows: Settings; a root room (the address at the root, or a room that keeps
  // the project, a phone's Inbox); else the open project.
  const room = roots.find(rootOn);
  const panel = settingsOpen ? (
    <SettingsPane settings={settings} footer={footer} view={view} onView={onView} onLeave={onLeaveSettings} themeRow={themeRow} />
  ) : project !== null && (room === undefined || room.keepsProject !== true) ? (
    <ProjectPane
      project={project}
      views={views}
      view={view}
      onView={onView}
      onSettings={() => onProjectSettings(project)}
      scope={scope}
      width={panelWidth}
      paired={machines}
      {...(onAddWorkspace !== undefined ? { onAddWorkspace } : {})}
      {...(onProjectMenu !== undefined ? { onMenu: (at: { x: number; y: number }) => onProjectMenu(project, at) } : {})}
    />
  ) : (
    <RootPane room={room ?? roots.find((v) => v.id === view) ?? roots[0]} />
  );

  return (
    <View
      {...(landmark("navigation") as object)}
      width={collapsed ? RAIL : RAIL + panelWidth}
      flexShrink={0}
      flexDirection="row"
      minHeight={0}
      backgroundColor={ground as never}
      {...(edge(t, { right: look.palette === "contrast" ? 1.5 : 1 }, look.palette === "contrast" ? "rule" : "line") as object)}
      overflow="hidden"
      position="relative"
    >
      <View
        width={RAIL}
        flexShrink={0}
        flexDirection="column"
        alignItems="center"
        minHeight={0}
        backgroundColor={(named ? t.v("chrome") : t.v("panel-3")) as never}
        {...((collapsed ? {} : edge(t, { right: 1 })) as object)}
      >
        {/* The rail's head is the window's drag handle on the desktop (`DRAG_REGION`) and holds nothing:
            macOS draws the window's three buttons over it (x 8–67 of the rail's 68), so the toggle leads
            the window's top row instead (`ShellSidebarToggle`, the window buttons mockups, 2026-11-16: A).
            A phone's drawer has no window buttons, and its head is where the drawer is closed from. */}
        <View height={phone ? 44 : 34} alignSelf="stretch" flexShrink={0} alignItems="center" justifyContent="center" style={DRAG_REGION as never}>
          {phone ? <SidebarToggle collapsed={collapsed} onCollapsed={onCollapsed} /> : null}
        </View>
        <View
          flex={1}
          minHeight={0}
          alignSelf="stretch"
          alignItems="center"
          gap={4}
          paddingBottom={6}
          {...((isWeb ? { overflowY: "auto", overflowX: "hidden", ...viewScrollbarProps(t) } : { overflow: "hidden" }) as object)}
        >
          {roots.map((v) => (
            <RailItem key={v.id} on={rootOn(v) && !settingsOpen} label={v.label} caption={v.short ?? v.label} counts={v.ring === undefined ? v.counts : undefined} onPress={() => goRoot(v)}>
              {(on) => (v.ring !== undefined ? <RoomTile ring={v.ring} glyph={v.glyph} on={on} /> : <RailIcon on={on} glyph={v.glyph} />)}
            </RailItem>
          ))}
          <View width={28} height={1} flexShrink={0} marginVertical={3} backgroundColor={t.v("line") as never} />
          {projects.map((p) => {
            const on = p.project === at;
            return (
              <View key={p.project} alignItems="center" gap={2} flexShrink={0}>
                <RailItem
                  on={on && !settingsOpen && room === undefined}
                  label={p.label}
                  caption={p.label}
                  title={p.project}
                  onPress={() => goProject(p)}
                  {...(onProjectMenu !== undefined ? { onMenu: (at: { x: number; y: number }) => onProjectMenu(p, at) } : {})}
                >
                  {() => <ProjectTile p={p} on={on} />}
                </RailItem>
                {collapsed && on
                  ? views.map((v) => (
                      <ViewIcon key={v.id} v={v} on={view === v.id && room === undefined && !settingsOpen} onPress={() => onView(v.id)} />
                    ))
                  : null}
              </View>
            );
          })}
          <RailItem on={false} label="open another project" caption="Open" onPress={openProjectMenu} disabled={busy} haspopup>
            {() => (
              <View width={34} height={34} borderRadius={10} alignItems="center" justifyContent="center" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)}>
                <Glyph scale={16 / 12.5}>+</Glyph>
              </View>
            )}
          </RailItem>
        </View>
        <View alignSelf="stretch" alignItems="center" gap={4} flexShrink={0} paddingTop={6} paddingBottom={8} {...(edge(t, { top: 1 }) as object)}>
          {collapsed
            ? footer.map((v) => (
                <RailItem key={v.id} on={view === v.id} label={v.label} caption={v.label} counts={v.counts} onPress={() => onView(v.id)}>
                  {(on) => <RailIcon on={on} glyph={v.glyph} />}
                </RailItem>
              ))
            : null}
          {update?.(true)}
          <RailItem
            on={view === settings.id}
            label={settings.label}
            caption={settings.label}
            counts={settings.counts}
            onPress={() => {
              if (collapsed) onCollapsed(false);
              onView(settings.id);
            }}
          >
            {(on) => <RailIcon on={on} glyph={settings.glyph} />}
          </RailItem>
        </View>
      </View>
      {collapsed ? null : (
        <View flex={1} minWidth={0} minHeight={0} flexDirection="column">
          {panel}
          {update?.(false)}
        </View>
      )}
      {openMenu !== null ? <ContextMenu anchor={openMenu} onClose={() => setOpenMenu(null)} /> : null}
    </View>
  );
}

/** A rail item: its icon or tile, its name under it, and a badge for what is waiting in it. */
function RailItem({
  on,
  label,
  caption,
  counts,
  title,
  onPress,
  disabled,
  haspopup = false,
  onMenu,
  children,
}: {
  on: boolean;
  label: string;
  caption: string;
  counts?: PillCounts | undefined;
  title?: string;
  onPress: (e: unknown) => void;
  disabled?: boolean;
  haspopup?: boolean;
  /** Its own menu, at the point it was right-clicked or held. */
  onMenu?: ((at: { x: number; y: number }) => void) | undefined;
  children: (on: boolean) => ReactNode;
}): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...menuProps(onMenu)}
      label={label}
      title={title ?? label}
      {...((on ? { "aria-current": "page" } : {}) as object)}
      {...((haspopup ? { "aria-haspopup": "menu" } : {}) as object)}
      {...(disabled !== undefined ? { disabled } : {})}
      width={RAIL - 8}
      flexShrink={0}
      position="relative"
      alignItems="center"
      gap={3}
      paddingTop={6}
      paddingBottom={5}
      borderRadius={8}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {children(on)}
      <Txt spec={{ voice: "app", scale: 0.78, weight: on ? 600 : 500, color: on ? "text" : "dim", lineHeight: 1.15 }} ellip maxWidth={RAIL - 12} textAlign="center">
        {caption}
      </Txt>
      <Badge counts={counts} />
    </Press>
  );
}

/** A control's own menu: on a right-click (web) and on a hold (a touch screen), at the pointer. */
function menuProps(onMenu: ((at: { x: number; y: number }) => void) | undefined): Record<string, unknown> {
  if (onMenu === undefined) return {};
  return {
    onLongPress: (e: { nativeEvent: { pageX: number; pageY: number } }) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }),
    ...(isWeb
      ? {
          onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => {
            e.preventDefault();
            onMenu({ x: e.clientX, y: e.clientY });
          },
        }
      : {}),
  };
}

/** A root room's icon, ringed while it is the room you are in. */
function RailIcon({ on, glyph }: { on: boolean; glyph: string }): JSX.Element {
  const t = useTokens();
  return (
    <View width={34} height={30} borderRadius={8} alignItems="center" justifyContent="center" backgroundColor={(on ? t.v("tint-accent") : "transparent") as never}>
      <Glyph scale={15 / 12.5} color={on ? "accent" : "dim"}>
        {glyph}
      </Glyph>
    </View>
  );
}

/**
 * A room across every project drawn as a project's tile is (All chats): its glyph on the tile, inside the
 * ring of everything in it — each conversation's own ring on one, a segment per thing working, asking or
 * finished unread — in place of the one-colour badge (the person, 2026-11-24: "the pip in the chat menu
 * should be segmented like the project level ring"). The room you are in keeps the accent.
 */
function RoomTile({ ring, glyph, on }: { ring: SidebarProject["ring"]; glyph: string; on: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View marginHorizontal={-5} marginTop={-5} marginBottom={-2}>
      <TileRing
        items={ring}
        size={44}
        on={on}
        letters={glyph}
        tile={(body, tint) => (
          <View
            width={34}
            height={34}
            borderRadius={10}
            alignItems="center"
            justifyContent="center"
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : "line") as object)}
            backgroundColor={(tint ?? (on ? t.v("tint-accent") : t.v("panel"))) as never}
          >
            {body}
          </View>
        )}
      />
    </View>
  );
}

/**
 * A project in the rail: two letters of its name on a tile, in its hue when the address is on it, inside
 * the ring of what it has working, asking and stopped (`StatusRing.tsx`) — which stands out 5 past the
 * tile on every side, over the item's padding rather than adding to its height.
 */
function ProjectTile({ p, on }: { p: SidebarProject; on: boolean }): JSX.Element {
  const t = useTokens();
  const hue = colorOf(t, p.hue);
  return (
    <View marginHorizontal={-5} marginTop={-5} marginBottom={-2}>
      <TileRing
        items={p.ring}
        size={44}
        on={on}
        letters={p.label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "·"}
        tile={(body, tint) => (
          <View
            width={34}
            height={34}
            borderRadius={10}
            alignItems="center"
            justifyContent="center"
            {...(edge(t, { top: on ? 1.5 : 1, right: on ? 1.5 : 1, bottom: on ? 1.5 : 1, left: on ? 1.5 : 1 }, on ? hue : "line") as object)}
            // The state's colour fills the tile (the person, 2026-11-15); the open project keeps its hue
            // on the tile's edge, and its ground where nothing is going on.
            backgroundColor={(tint ?? (on ? t.mix(hue, 22, "transparent") : t.v("panel"))) as never}
          >
            {body}
          </View>
        )}
      />
    </View>
  );
}

/** One of the open project's rooms, under its tile while the panel is shut. */
function ViewIcon({ v, on, onPress }: { v: SidebarView; on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const worst = worstOf(v.counts);
  return (
    <Press
      onPress={onPress}
      label={v.label}
      title={v.label}
      {...((on ? { "aria-current": "page" } : {}) as object)}
      width={40}
      height={26}
      flexShrink={0}
      position="relative"
      alignItems="center"
      justifyContent="center"
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: on ? t.v("panel") : hovered ? t.v("fill-ghost-hover") : "transparent", ...(on ? edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) : {}) })}
    >
      <Glyph scale={12 / 12.5} color={on ? "text" : "dim"}>
        {v.glyph}
      </Glyph>
      {worst !== null ? <View position="absolute" top={3} right={8} width={6} height={6} borderRadius={999} backgroundColor={t.v(INK[worst.kind] ?? "dim") as never} /> : null}
    </Press>
  );
}

/** The most urgent thing waiting in a rail item, as a count in its colour over the item's top right. */
function Badge({ counts }: { counts: PillCounts | undefined }): JSX.Element | null {
  const t = useTokens();
  const worst = worstOf(counts);
  if (worst === null) return null;
  return (
    <View
      position="absolute"
      top={1}
      right={6}
      minWidth={16}
      height={16}
      paddingHorizontal={4}
      borderRadius={8}
      alignItems="center"
      justifyContent="center"
      backgroundColor={t.v(INK[worst.kind] ?? "dim") as never}
      pointerEvents="none"
      {...((isWeb ? { title: `${worst.n ?? ""} ${worst.kind}`.trim() } : {}) as object)}
    >
      <Txt spec={{ voice: "data", scale: 0.7, weight: 700, color: "panel", lineHeight: { px: 12 }, tabular: true }}>{worst.n !== undefined ? String(worst.n) : "•"}</Txt>
    </View>
  );
}

/** The panel's head: a name, what goes beside it, and the room's verbs. */
function PaneHead({ children, acts = [] }: { children: ReactNode; acts?: readonly SidebarAct[] }): JSX.Element {
  const phone = usePhone();
  return (
    <View flexDirection="row" alignItems="center" gap={4} flexShrink={0} height={phone ? 48 : 40} paddingLeft={12} paddingRight={8} style={DRAG_REGION as never}>
      <View flex={1} minWidth={0} flexDirection="row" alignItems="baseline" gap={6}>
        {children}
      </View>
      <View flexDirection="row" alignItems="center" gap={2} style={NO_DRAG as never}>
        {acts.map((act) => (
          <ActButton key={act.id} act={act} />
        ))}
      </View>
    </View>
  );
}

function ActButton({ act }: { act: SidebarAct }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      // The button itself, for a verb that opens a menu under it (`SidebarAct.onAct`): on web the press
      // event's element; a phone has none, and the menu takes its own place.
      onPress={(e) => act.onAct((isWeb ? (e as unknown as { currentTarget: HTMLElement }).currentTarget : undefined) as never)}
      label={act.label}
      title={act.label}
      {...((act.on !== undefined ? { "aria-pressed": act.on } : {}) as object)}
      width={ACT_WIDTH + 4}
      height={ACT_WIDTH + 4}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      box={({ hovered }) => ({ backgroundColor: act.on === true ? t.v("tint-accent") : hovered ? t.v("fill-ghost-selected") : "transparent" })}
    >
      {({ hovered }) => <Glyph scale={12 / 12.5} color={act.on === true ? "accent" : hovered ? "text" : "dim"}>{act.glyph}</Glyph>}
    </Press>
  );
}

/** What fills the panel below its head: a drawer, its own scroller or not. */
function Drawer({ children, scrolls = false }: { children: ReactNode; scrolls?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="column"
      // `flex: 1` with its basis said as CSS reads it: Yoga's 0 would collapse a drawer to nothing.
      flexGrow={1}
      flexShrink={1}
      flexBasis="auto"
      minHeight={0}
      paddingHorizontal={6}
      paddingBottom={6}
      {...((scrolls ? (isWeb ? { overflowY: "auto", overflowX: "hidden", ...viewScrollbarProps(t) } : { overflow: "hidden" }) : {}) as object)}
    >
      {children}
    </View>
  );
}

/**
 * The open project: its title (a breadcrumb that narrows the panel, {@link Crumb}), its rooms as tabs,
 * the chosen room's verbs in a bar under them, and the room's drawer.
 */
function ProjectPane({
  project,
  views,
  view,
  onView,
  onSettings,
  scope,
  width,
  paired,
  onAddWorkspace,
  onMenu,
}: {
  paired: NonNullable<SidebarProps["machines"]>;
  onAddWorkspace?: (machineId?: string, at?: { x: number; y: number }) => void;
  onMenu?: (at: { x: number; y: number }) => void;
  project: SidebarProject;
  views: readonly SidebarView[];
  view: string;
  onView: (id: string) => void;
  onSettings: () => void;
  scope: SidebarProps["scope"];
  width: number;
}): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const current = views.find((v) => v.id === view) ?? views.find((v) => v.id === "chat") ?? views[0];
  const settingsAct: SidebarAct = { id: "project-settings", glyph: "⚙", label: `${project.label}'s settings`, onAct: onSettings };
  return (
    <>
      <PaneHead acts={[settingsAct]}>
        <Crumb project={project} scope={scope} width={width - 12 - 8 - ACT_WIDTH - 8} paired={paired} {...(onAddWorkspace !== undefined ? { onAddWorkspace } : {})} {...(onMenu !== undefined ? { onMenu } : {})} />
      </PaneHead>
      <View {...(isWeb ? { role: "tablist" } : {})} flexDirection="row" gap={2} padding={2} marginHorizontal={8} marginBottom={6} borderRadius={8} flexShrink={0} backgroundColor={t.v("panel-3") as never}>
        {views.map((v) => {
          const on = v.id === current?.id;
          const worst = worstOf(v.counts);
          return (
            <Press
              key={v.id}
              role="tab"
              {...({ "aria-selected": on } as object)}
              onPress={() => onView(v.id)}
              label={v.label}
              flex={1}
              height={phone ? 34 : 26}
              flexDirection="row"
              alignItems="center"
              justifyContent="center"
              gap={5}
              borderRadius={6}
              box={({ hovered }) => ({
                backgroundColor: on ? t.v("panel") : hovered ? t.v("fill-ghost-hover") : "transparent",
                ...(on ? edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) : {}),
              })}
            >
              <Txt spec={{ voice: "app", scale: 0.92, weight: on ? 600 : 500, color: on ? "text" : "dim" }} whiteSpace="nowrap">
                {v.label}
              </Txt>
              {worst !== null ? <View width={6} height={6} borderRadius={999} backgroundColor={t.v(INK[worst.kind] ?? "dim") as never} /> : null}
            </Press>
          );
        })}
      </View>
      {current?.acts !== undefined && current.acts.length > 0 ? <RoomBar acts={current.acts} room={current.label} /> : null}
      {current?.panel !== undefined ? (
        <Drawer>{current.panel}</Drawer>
      ) : (
        <Drawer>
          <Summary counts={current?.counts} onSeen={current?.onSeen} words="This project's board is open beside the sidebar." />
        </Drawer>
      )}
    </>
  );
}

/**
 * The chosen room's verbs, under the tabs and over the list they act on (the person, 2026-11-12: "the
 * button for add and search dont make sense placement wise"): find as a field-shaped toggle that
 * fills the row, the room's `+` as its one filled button, any other verb as a glyph.
 */
function RoomBar({ acts, room }: { acts: readonly SidebarAct[]; room: string }): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const height = phone ? 34 : 28;
  const pressOf = (act: SidebarAct) => (e: unknown) => act.onAct((isWeb ? (e as { currentTarget: HTMLElement }).currentTarget : undefined) as never);
  return (
    <View flexDirection="row" alignItems="center" gap={4} paddingHorizontal={8} paddingBottom={4} flexShrink={0}>
      {acts.map((act) =>
        act.id === "find" ? (
          <Press
            key={act.id}
            onPress={pressOf(act)}
            label={act.label}
            title={act.label}
            {...({ "aria-pressed": act.on === true } as object)}
            flex={1}
            minWidth={0}
            height={height}
            flexDirection="row"
            alignItems="center"
            gap={6}
            paddingHorizontal={8}
            borderRadius={8}
            box={({ hovered }) => ({
              backgroundColor: t.v("bg"),
              ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, act.on === true ? "accent" : hovered ? "rule" : "line"),
            })}
          >
            <Glyph scale={12 / 12.5} color="dim">
              ⌕
            </Glyph>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} ellip flex={1} minWidth={0}>
              {act.on === true ? "Searching…" : `Search ${room.toLowerCase()}`}
            </Txt>
          </Press>
        ) : act.id === "new" ? (
          <View key={act.id} flexDirection="row" flexShrink={0} borderRadius={7} overflow="hidden">
            <Press
              onPress={pressOf(act)}
              label={act.label}
              title={act.label}
              height={height}
              flexDirection="row"
              alignItems="center"
              gap={4}
              paddingHorizontal={9}
              box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-accent-hover") : t.v("fill-accent") })}
            >
              <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 600, color: "on-accent" }}>+</Txt>
              <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "on-accent" }}>New</Txt>
            </Press>
            {act.more !== undefined ? (
              <Press
                onPress={(e) => act.more!((isWeb ? (e as unknown as { currentTarget: HTMLElement }).currentTarget : undefined) as never)}
                label="More ways to start"
                title="more ways to start"
                {...({ "aria-haspopup": "menu" } as object)}
                width={20}
                height={height}
                alignItems="center"
                justifyContent="center"
                {...(edge(t, { left: 1 }, "rule") as object)}
                box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-accent-hover") : t.v("fill-accent") })}
              >
                <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "on-accent" }}>⌄</Txt>
              </Press>
            ) : null}
          </View>
        ) : (
          <ActButton key={act.id} act={act} />
        ),
      )}
    </View>
  );
}

/**
 * The project panel's title: `project › [machine | workspace]` on ONE line (boards 49–50). The step
 * you are on is the title, large; short of room the steps before it shrink to their icons, oldest
 * first (`crumbFit`), and only then does its name trim. The machine and the workspace are two halves
 * of one pill, each its own menu; a workspace is on one machine, so choosing it chooses that machine.
 * The ✕ lets the narrowing go; so does pressing the project. A project of one workspace has the pill
 * too: it is how a second is added (the machine menu's Add) and how one is switched to.
 */
/** "This machine", as {@link Crumb} names it to whoever adds a workspace: the region knows its id. */
export const SELF_ADD = "@self";

function Crumb({
  project,
  scope,
  width,
  paired = [],
  onAddWorkspace,
  onMenu,
}: {
  project: SidebarProject;
  scope: SidebarProps["scope"];
  width: number;
  paired?: NonNullable<SidebarProps["machines"]>;
  onAddWorkspace?: (machineId?: string, at?: { x: number; y: number }) => void;
  /** The project's own verbs, on a right-click of its name. */
  onMenu?: (at: { x: number; y: number }) => void;
}): JSX.Element {
  const t = useTokens();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // Another workspace of the project (decision 0027): every machine's row has Add under the pointer —
  // one that has a workspace already takes a second, one that has none (this machine among them) its
  // first — and the last item opens the full form.
  const adding = (holding: ReadonlySet<string>, at: { x: number; y: number }): MenuItem[] =>
    onAddWorkspace === undefined
      ? []
      : [
          ...machinesWithout(paired, holding).map((m, i) => {
            const id = m.self ? SELF_ADD : m.id;
            return {
              label: m.label,
              ...(i === 0 ? { separator: true } : {}),
              note: m.online ? "no workspace" : "offline",
              disabled: !m.online,
              onSelect: () => onAddWorkspace(id, at),
              ...(m.online ? { action: { label: "Add", onSelect: () => onAddWorkspace(id, at) } } : {}),
            };
          }),
          { label: "Add a workspace…", separator: true, onSelect: () => onAddWorkspace() },
        ];
  if (scope === undefined) {
    return (
      <View flexShrink={1} minWidth={0} {...(menuProps(onMenu) as object)}>
        <Txt register="data-title" ellip {...({ title: project.project } as object)}>
          {project.label}
        </Txt>
      </View>
    );
  }
  const { machines, scope: now, onScope } = scope;
  const machine = machines.find((m) => m.id === now.machine);
  const workspace = machine?.workspaces.find((w) => w.project === now.workspace);
  const narrowed = machine !== undefined;
  const fit = crumbFit({ project: project.label, ...(machine !== undefined ? { machine: machine.label } : {}), ...(workspace !== undefined ? { workspace: workspace.label } : {}) }, width - (narrowed ? 20 : 0));
  const hue = colorOf(t, project.hue);
  const anchor = (e: unknown): { x: number; y: number } => {
    const box = isWeb ? (e as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect() : undefined;
    const touch = (e as { nativeEvent?: { pageX?: number; pageY?: number } }).nativeEvent;
    return { x: box?.left ?? touch?.pageX ?? 0, y: box !== undefined ? box.bottom + 4 : (touch?.pageY ?? 0) };
  };
  const machineMenu = (e: unknown): void => {
    const at = anchor(e);
    setMenu({
      ...at,
      items: [
        { label: "All machines", checked: !narrowed, onSelect: () => onScope({}) },
        ...machines.map((m, i) => ({
          label: m.label,
          checked: m.id === now.machine,
          ...(i === 0 ? { separator: true } : {}),
          note: [m.self ? "this machine" : m.state === "online" ? undefined : m.state, `${m.workspaces.length} workspace${m.workspaces.length === 1 ? "" : "s"}`].filter((x) => x !== undefined).join(" · "),
          onSelect: () => onScope(m.workspaces.some((w) => w.project === now.workspace) ? now : { machine: m.id }),
          ...(onAddWorkspace !== undefined && m.state === "online" ? { action: { label: "Add", onSelect: () => onAddWorkspace(m.self ? SELF_ADD : m.id, at) } } : {}),
        })),
        ...adding(new Set(machines.map((m) => m.id)), at),
      ],
    });
  };
  // Add a workspace (the person, 2026-11-20): on the machine the pill is narrowed to, else asked which.
  const addTo = (m: { id: string; self: boolean }, at: { x: number; y: number }): void => onAddWorkspace?.(m.self ? SELF_ADD : m.id, at);
  const addWorkspace = (at: { x: number; y: number }): MenuItem[] =>
    onAddWorkspace === undefined
      ? []
      : [
          machine !== undefined
            ? {
                label: "Add a workspace…",
                note: `on ${machine.label}`,
                separator: true,
                disabled: machine.state !== "online",
                onSelect: () => addTo(machine, at),
              }
            : {
                label: "Add a workspace…",
                separator: true,
                onSelect: () =>
                  setMenu({
                    ...at,
                    title: "Add a workspace on which machine?",
                    items: addWorkspaceQuestion(addTargetsOf(machines, paired), (m) => addTo(m, at), () => onAddWorkspace()),
                  }),
              },
        ];
  const workspaceMenu = (e: unknown): void => {
    const shown = machine === undefined ? machines : [machine];
    const at = anchor(e);
    setMenu({
      ...at,
      items: [
        { label: "All workspaces", checked: now.workspace === undefined, ...(machine !== undefined ? { note: `on ${machine.label}` } : {}), onSelect: () => onScope(machine !== undefined ? { machine: machine.id } : {}) },
        ...shown.flatMap((m, i) =>
          m.workspaces.map((w, j) => ({
            label: w.label,
            checked: w.project === now.workspace,
            ...(i === 0 && j === 0 ? { separator: true } : {}),
            note: machine === undefined ? `${m.label} · ${w.dir}` : w.dir,
            onSelect: () => onScope({ machine: m.id, workspace: w.project }),
          })),
        ),
        ...addWorkspace(at),
      ],
    });
  };
  const half = { flexDirection: "row", alignItems: "center", gap: 5, height: 24, paddingHorizontal: 6, flexShrink: 0, minWidth: 0 } as const;
  const smallSpec = { voice: "data", scale: 11.5 / 12.5, weight: 500, color: "dim" } as const;
  const name = (step: "machine" | "workspace", label: string): JSX.Element =>
    fit.current === step ? (
      <Txt register="data-title" ellip flexShrink={1} minWidth={0}>
        {label}
      </Txt>
    ) : (
      <Txt spec={smallSpec} whiteSpace="nowrap">
        {label}
      </Txt>
    );
  // The pill's marks are line icons (`iconPaths.ts`), drawn the same on a phone as on the desktop and
  // centred on the row: a screen on its stand for the machine, a folder for the workspace, a chevron
  // for each menu. They were font glyphs (▭, ❏, ⌄): a bare box and a shadowed square that said neither,
  // of two sizes, and chevrons that hung below the names on the font's baseline.
  const ink = (on: boolean): string => String(t.v(on ? "text" : "dim"));
  const chevron = <Icon name="chevron" size={11} color={ink(false)} />;
  const machineDot = (m: ScopeMachine | undefined): JSX.Element => (
    <View width={6} height={6} borderRadius={999} flexShrink={0} backgroundColor={t.v(m === undefined || m.state === "online" ? "ok" : "warn") as never} />
  );
  return (
    <View flex={1} minWidth={0} flexDirection="row" alignItems="center" gap={2} style={NO_DRAG as never} {...((isWeb ? { overflow: "hidden" } : {}) as object)}>
      <Press
        onPress={() => onScope({})}
        {...menuProps(onMenu)}
        disabled={!narrowed}
        label={narrowed ? `${project.label}: show every machine` : project.label}
        title={project.project}
        flexShrink={fit.current === "project" ? 1 : 0}
        minWidth={0}
        borderRadius={6}
        paddingHorizontal={fit.project === "icon" ? 2 : 4}
        height={26}
        justifyContent="center"
        box={({ hovered }) => ({ backgroundColor: hovered && narrowed ? t.v("fill-ghost-hover") : "transparent" })}
      >
        {fit.project === "icon" ? (
          <View width={20} height={20} borderRadius={6} alignItems="center" justifyContent="center" backgroundColor={t.mix(hue, 22, "transparent") as never} {...(edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, hue) as object)}>
            <Txt spec={{ voice: "data", scale: 9 / 12.5, weight: 600, color: "text" }}>{project.label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "·"}</Txt>
          </View>
        ) : fit.current === "project" ? (
          <Txt register="data-title" ellip>
            {project.label}
          </Txt>
        ) : (
          <Txt spec={smallSpec} whiteSpace="nowrap">
            {project.label}
          </Txt>
        )}
      </Press>
      <Txt spec={{ voice: "app", scale: 1, color: "faint" }}>›</Txt>
      <View flexDirection="row" alignItems="center" minWidth={0} flexShrink={1} borderRadius={7} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
        <Press onPress={machineMenu} label={machine === undefined ? "Machine: all" : `Machine: ${machine.label}`} title={machine === undefined ? "Show one machine" : `${machine.label} · ${machine.state}`} {...({ "aria-haspopup": "menu" } as object)} {...half} flexShrink={fit.current === "machine" ? 1 : 0} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          <Icon name="system" size={14} color={ink(machine !== undefined)} />
          {machineDot(machine)}
          {machine !== undefined && fit.machine === "name" ? name("machine", machine.label) : null}
          {fit.current === "machine" || machine === undefined ? chevron : null}
        </Press>
        <View width={1} height={14} flexShrink={0} backgroundColor={t.v("line") as never} />
        <Press onPress={workspaceMenu} label={workspace === undefined ? "Workspace: all" : `Workspace: ${workspace.label}`} title={workspace === undefined ? "Show one workspace" : workspace.dir} {...({ "aria-haspopup": "menu" } as object)} {...half} flexShrink={fit.current === "workspace" ? 1 : 0} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          <Icon name="folder" size={14} color={ink(workspace !== undefined)} />
          {workspace !== undefined ? name("workspace", workspace.label) : null}
          {chevron}
        </Press>
      </View>
      {narrowed ? (
        <Press onPress={() => onScope({})} label="Show every machine again" title="show every machine again" width={18} height={18} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={4} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          <Icon name="cross" size={11} color={ink(false)} />
        </Press>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** A room at the root of the address (All tasks, All chats, a phone's Inbox): its name and its drawer. */
function RootPane({ room }: { room: SidebarView | undefined }): JSX.Element {
  return (
    <>
      <PaneHead acts={room?.acts ?? []}>
        <Txt register="app-title" ellip flexShrink={1} minWidth={0}>
          {room?.label ?? ""}
        </Txt>
      </PaneHead>
      {room?.panel !== undefined ? (
        <Drawer>{room.panel}</Drawer>
      ) : (
        <Drawer>
          <Summary counts={room?.counts} onSeen={room?.onSeen} words="Every project's board is open beside the sidebar." />
        </Drawer>
      )}
    </>
  );
}

/** A room with no drawer: what is waiting in it, and where its content is. */
function Summary({ counts, onSeen, words }: { counts: PillCounts | undefined; onSeen: SidebarView["onSeen"]; words: string }): JSX.Element {
  return (
    <View paddingHorizontal={6} paddingTop={4} gap={8}>
      {counts !== undefined ? <Pills counts={counts} budget={240} onClear={onSeen === undefined ? undefined : (from) => onSeen(from as never)} /> : null}
      <Txt register="app-secondary">{words}</Txt>
    </View>
  );
}

/** Settings: its sections, and the rooms that live inside it (Logs, Debug, Components) at its foot. */
function SettingsPane({
  settings,
  footer,
  view,
  onView,
  onLeave,
  themeRow,
}: {
  settings: SidebarView;
  footer: readonly SidebarView[];
  view: string;
  onView: (id: string) => void;
  onLeave: () => void;
  themeRow: ReactNode;
}): JSX.Element {
  const t = useTokens();
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={6} flexShrink={0} minHeight={40} paddingVertical={settings.crumb !== undefined ? 6 : 0} paddingHorizontal={8} style={DRAG_REGION as never}>
        <Press
          onPress={onLeave}
          label="Back"
          title="back to where you were"
          style={NO_DRAG}
          width={24}
          height={24}
          alignItems="center"
          justifyContent="center"
          borderRadius={5}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-selected") : "transparent" })}
        >
          {({ hovered }) => <Glyph scale={16 / 12.5} color={hovered ? "text" : "dim"}>‹</Glyph>}
        </Press>
        {/* Settings' path beside its name, when the region gives one (`SettingsCrumb`). */}
        {settings.crumb ?? (
          <Txt register="app-title" ellip flex={1} minWidth={0}>
            {settings.label}
          </Txt>
        )}
        {settings.counts !== undefined ? (
          <View style={NO_DRAG as never}>
            <Pills counts={settings.counts} budget={90} onClear={settings.onSeen === undefined ? undefined : (from) => settings.onSeen!(from as never)} {...(settings.seenTitle !== undefined ? { clearTitle: settings.seenTitle } : {})} />
          </View>
        ) : null}
      </View>
      <View flexGrow={0} flexShrink={1} flexBasis="auto" minHeight={0} paddingHorizontal={6} {...((isWeb ? { overflowY: "auto", overflowX: "hidden", ...viewScrollbarProps(t) } : { overflow: "hidden" }) as object)}>
        {settings.panel}
      </View>
      <View flexDirection="column" gap={1} flexShrink={0} marginTop="auto" paddingTop={6} paddingHorizontal={6} paddingBottom={6} {...(edge(t, { top: 1 }) as object)}>
        {footer.map((v) => (
          <ListRow key={v.id} on={view === v.id} glyph={v.glyph} label={v.label} counts={v.counts} onSeen={v.onSeen} seenTitle={v.seenTitle} onPress={() => onView(v.id)} />
        ))}
        {themeRow}
      </View>
    </>
  );
}

/** A plain row of the panel (Settings' foot): its glyph, its name, its pills. */
function ListRow({
  on,
  glyph,
  label,
  title,
  counts,
  onSeen,
  seenTitle,
  onPress,
}: {
  on: boolean;
  glyph: string;
  label: string;
  title?: string;
  counts?: PillCounts | undefined;
  onSeen?: SidebarView["onSeen"];
  seenTitle?: string | undefined;
  onPress: () => void;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const phone = usePhone();
  const [hovered, hover] = useHover();
  // The row you are on, as each palette draws it.
  const onStyle: Record<string, unknown> =
    look.palette === "contrast"
      ? { backgroundColor: "transparent", boxShadow: `inset 0 0 0 1.5px ${String(t.v("rule"))}` }
      : look.palette === "zinc"
        ? look.scheme === "dark"
          ? { backgroundColor: "#191a1d" }
          : { backgroundColor: t.v("panel"), boxShadow: `0 0 0 1px ${String(t.v("line"))}` }
        : { backgroundColor: t.v("tint-accent") };
  return (
    <View
      {...(hover as object)}
      flexDirection="row"
      alignItems="center"
      gap={4}
      height={phone ? 40 : 28}
      flexShrink={0}
      borderRadius={6}
      backgroundColor={(hovered ? t.v("fill-ghost-hover") : "transparent") as never}
      {...((on ? onStyle : {}) as object)}
    >
      <Press
        onPress={onPress}
        label={label}
        title={title ?? label}
        {...((on ? { "aria-current": "page" } : {}) as object)}
        flex={1}
        minWidth={0}
        alignSelf="stretch"
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingHorizontal={8}
        borderRadius={6}
      >
        <Glyph width={15} color={on ? "text" : "dim"}>
          {glyph}
        </Glyph>
        <Txt spec={{ voice: "app", scale: 0.92, weight: 500, color: on ? "text" : "dim" }} ellip flex={1} minWidth={0}>
          {label}
        </Txt>
      </Press>
      {counts !== undefined ? <Pills counts={counts} budget={90} onClear={onSeen === undefined ? undefined : (from) => onSeen(from as never)} {...(seenTitle !== undefined ? { clearTitle: seenTitle } : {})} /> : null}
    </View>
  );
}
