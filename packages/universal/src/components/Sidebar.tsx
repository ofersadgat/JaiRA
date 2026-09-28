import { Fragment, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { parentName } from "@jaira/ui/projects";
import type { SidebarProject, SidebarView } from "@jaira/ui/sidebar";
import { Glyph, Press, Txt, edge, useHover } from "../primitives";
import { TokenScope, useLook, useTokens, type Tokens } from "../tokens";
import { Pills } from "./Pills";

/**
 * `sidebar.tsx`'s `Sidebar`, universal (decision 0015). Read that one for what the column is and why;
 * this one has to look and behave the same. The rules it carries, from `styles.css` (`cascade.mts
 * .sidebar` prints them as Chromium applies them):
 *
 *   .sidebar             column, width --sidebar, border-right --line; its own variables (`TokenScope`);
 *                        ground --panel-2, or --chrome under any named palette
 *   .side-title          34 tall, padding 0 8, row, gap 8: the toggle (26 square, 11/12.5 app, -0.05em)
 *                        and the brand (app-label)
 *   .side-nav/.side-foot column, gap 1, padding 0 6 6; the foot 6 on top, under a --line
 *   .side-roots          the root rows, 5 below, under a --line, 3 more below that
 *   .side-row            26 tall, row, gap 4, radius 6; hover --fill-ghost-hover, on --tint-accent
 *   .side-hit            the row's target: flex 1, padding 0 7, gap 8
 *   .side-glyph          15 wide, centred, 12.5/12.5 app, --dim (--text on the row you are on)
 *   .side-label          app-label (or app-secondary on "Open a project…"), one line
 *   .side-act            20 square, radius 5, 11/12.5 app, --dim at half opacity until its row is
 *                        hovered or on; hover --fill-ghost-selected, on --accent over --tint-accent
 *   .side-section.open   --panel between two --lines, 4 -6 outside, 0 6 4 inside, takes the height
 *   .side-project-row    padding 0 8 0 0, gap 7; its target 5 0 5 8 (8 0 6 8 when open), gap 7
 *   .side-dot            7 round, the project's hue
 *   .side-name           baseline row, gap 6: the name (data-title open, data-secondary shut) and
 *                        where it is (data-faint, right-aligned, yields first)
 *   .side-views          indented 12, a --rule on the left, 8 inside it, 4 below
 *   .side-drawer         3 0 6 6 outside, a --line on the left, 8 inside
 *   .side-twist          16×20, 9/12.5 app, --dim
 *   .side-project-settings   shown only while the row is hovered (web; a phone has no hover)
 *   palettes             contrast: a 1.5px --rule edge, and the row you are on ringed rather than
 *                        filled; pastel(-rail): that row rounder (9); zinc: that row --panel with a
 *                        --line ring, or #191a1d in the dark
 *   .sidebar.shut        the rail: rows 34 wide and centred, no labels or pills, project tiles
 *   .side-panel          Settings over the column: top 34, padding 4 6 6, --panel-2, --lift
 */
const ROW_PILL_BUDGET = 96;
const OPEN_PILL_BUDGET = 62;
const ACT_WIDTH = 20;

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
  update?: ((collapsed: boolean) => ReactNode) | undefined;
  /** `--sidebar`: the column's width while it is open. */
  width: number;
};

/** The rail's width, `uiState.ts`'s `SIDEBAR_RAIL`. */
const RAIL = 46;

export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <TokenScope scope="sidebar">
      <Column {...props} />
    </TokenScope>
  );
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
  update,
  width,
}: SidebarProps): JSX.Element {
  const t = useTokens();
  const look = useLook();

  const rowOf = (v: SidebarView, nested: boolean, scope: "root" | "project" | "any" = "any", mode?: { back?: () => void; expand?: () => void }): JSX.Element => {
    const inScope = scope === "any" || (scope === "root") === (at === null);
    const here = view === v.id && inScope;
    const drawer = v.panel !== undefined && (here || mode?.back !== undefined) && !collapsed;
    const acts = collapsed ? [] : (v.acts ?? []);
    const go = (): void => {
      if (mode?.back !== undefined) return mode.back();
      mode?.expand?.();
      if (scope === "root" && at !== null) onProject(null);
      onView(v.id);
    };
    return (
      <Fragment key={v.id}>
        <Row on={here} rail={collapsed}>
          {(hovered) => (
            <>
              {mode?.back !== undefined ? (
                <Press onPress={mode.back} label="Back" title="back to where you were" width={20} height={20} marginLeft={4} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered: h }) => ({ backgroundColor: h ? t.v("fill-ghost-selected") : "transparent" })}>
                  {({ hovered: h }) => (
                    <Glyph scale={16 / 12.5} color={h ? "text" : "dim"} lineHeight={Number(t.scaled("size-app", 16 / 12.5)) || undefined}>
                      ‹
                    </Glyph>
                  )}
                </Press>
              ) : null}
              <Press
                onPress={go}
                label={v.label}
                title={v.label}
                flex={1}
                minWidth={0}
                alignSelf="stretch"
                flexDirection="row"
                alignItems="center"
                gap={8}
                paddingLeft={collapsed ? 0 : mode?.back !== undefined ? 3 : 7}
                paddingRight={collapsed ? 0 : 7}
                justifyContent={collapsed ? "center" : "flex-start"}
                borderRadius={6}
              >
                <Glyph width={15} color={here ? "text" : "dim"}>
                  {v.glyph}
                </Glyph>
                {collapsed ? null : (
                  <Txt register="app-label" ellip flex={1} minWidth={0} color={(here ? t.v("text") : t.v("dim")) as never}>
                    {v.label}
                  </Txt>
                )}
              </Press>
              {acts.map((act) => (
                <Press
                  key={act.id}
                  // The button itself, for a verb that opens a menu under it (`SidebarAct.onAct`): on web the
                  // press event's element; a phone has none, and the menu takes its own place.
                  onPress={(e) => act.onAct((isWeb ? (e as unknown as { currentTarget: HTMLElement }).currentTarget : undefined) as never)}
                  label={act.label}
                  title={act.label}
                  width={20}
                  height={20}
                  flexShrink={0}
                  alignItems="center"
                  justifyContent="center"
                  borderRadius={5}
                  opacity={hovered || here || act.on === true ? 1 : 0.5}
                  box={({ hovered: h }) => ({ backgroundColor: act.on === true ? t.v("tint-accent") : h ? t.v("fill-ghost-selected") : "transparent" })}
                >
                  {({ hovered: h }) => <Glyph scale={11 / 12.5} color={act.on === true ? "accent" : h ? "text" : "dim"}>{act.glyph}</Glyph>}
                </Press>
              ))}
              {v.counts !== undefined && !collapsed ? (
                <Pills counts={v.counts} budget={ROW_PILL_BUDGET - acts.length * ACT_WIDTH} onClear={v.onSeen === undefined ? undefined : () => v.onSeen!(undefined as never)} {...(v.seenTitle !== undefined ? { clearTitle: v.seenTitle } : {})} />
              ) : null}
            </>
          )}
        </Row>
        {drawer ? (
          <View
            flexDirection="column"
            // In the Settings panel the drawer is as tall as its list and scrolls past that
            // (`.side-panel > .side-drawer { flex: 0 1 auto; overflow-y: auto }`); in the column it takes the rest.
            {...(mode?.back !== undefined ? { flexGrow: 0, flexShrink: 1, flexBasis: "auto", ...(isWeb ? { overflowY: "auto", overflowX: "hidden" } : { overflow: "hidden" }) } : { flex: 1 })}
            minHeight={0}
            marginTop={3}
            marginBottom={6}
            marginLeft={6}
            paddingLeft={8}
            {...(edge(t, { left: 1 }) as object)}
          >
            {v.panel}
          </View>
        ) : null}
      </Fragment>
    );
  };

  const projectRow = (p: SidebarProject): JSX.Element => {
    const open = p.project === at;
    return (
      <View
        key={p.project}
        {...(open
          ? {
              backgroundColor: t.v("panel") as never,
              ...edge(t, { top: 1, bottom: 1 }),
              marginVertical: 4,
              marginHorizontal: -6,
              paddingTop: 0,
              paddingHorizontal: 6,
              paddingBottom: 4,
              flex: 1,
              minHeight: 0,
            }
          : { flexShrink: 0 })}
      >
        <ProjectRow p={p} open={open} onProject={onProject} onProjectSettings={onProjectSettings} />
        {open ? (
          <View flex={1} minHeight={0} gap={1} marginLeft={12} paddingLeft={8} paddingBottom={4} {...(edge(t, { left: 1 }, "rule") as object)}>
            {views.map((v) => rowOf(v, true, "project"))}
          </View>
        ) : null}
      </View>
    );
  };

  const themeRow = (
    <Press
      onPress={() => onTheme(theme === "dark" ? "light" : "dark")}
      label="Toggle theme"
      title={theme === "dark" ? "switch to light" : "switch to dark"}
      width={collapsed ? 34 : "100%"}
      height={26}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      justifyContent={collapsed ? "center" : "flex-start"}
      gap={8}
      paddingHorizontal={collapsed ? 0 : 7}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Glyph width={15}>{theme === "dark" ? "☀" : "☾"}</Glyph>
      {collapsed ? null : (
        <Txt register="app-label" ellip flex={1} minWidth={0}>
          {theme === "dark" ? "Light" : "Dark"}
        </Txt>
      )}
    </Press>
  );

  const settingsPanel = !collapsed && (view === settings.id || footer.some((row) => row.id === view));
  const named = look.palette !== "classic";

  return (
    <View
      width={collapsed ? RAIL : width}
      flexShrink={0}
      flexDirection="column"
      minHeight={0}
      backgroundColor={(named ? t.v("chrome") : t.v("panel-2")) as never}
      {...(edge(t, { right: look.palette === "contrast" ? 1.5 : 1 }, look.palette === "contrast" ? "rule" : "line") as object)}
      overflow="hidden"
      position="relative"
    >
      <View flexDirection="row" alignItems="center" justifyContent={collapsed ? "center" : "flex-start"} gap={8} flexShrink={0} height={34} paddingHorizontal={collapsed ? 4 : 8}>
        <Press
          onPress={() => onCollapsed(!collapsed)}
          label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
          title={collapsed ? "show the sidebar" : "hide the sidebar"}
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
        {collapsed ? null : (
          <Txt register="app-label" flexShrink={0}>
            JAIRA
          </Txt>
        )}
      </View>

      {collapsed ? (
        <View flexDirection="column" alignItems="center" flex={1} minHeight={0} paddingBottom={6}>
          <View flexDirection="column" alignItems="center" gap={1} flexShrink={0}>
            {roots.map((v) => rowOf(v, false, "root"))}
          </View>
          <RailSplit />
          <View flexDirection="column" alignItems="center" gap={1} flexShrink={0}>
            {projects.map((p) => (
              <RailTile key={p.project} p={p} on={p.project === at} onPress={() => onProject(p.project === at ? null : p.project)} />
            ))}
          </View>
          {at !== null && views.length > 0 ? (
            <>
              <RailSplit />
              <View flexDirection="column" alignItems="center" gap={1} flexShrink={0}>
                {views.map((v) => rowOf(v, false))}
              </View>
            </>
          ) : null}
        </View>
      ) : (
        <View flexDirection="column" gap={1} paddingHorizontal={6} paddingBottom={6} minHeight={0} flex={1}>
          <View flexDirection="column" gap={1} flexShrink={0} paddingBottom={5} marginBottom={3} {...(edge(t, { bottom: 1 }) as object)}>
            {roots.map((v) => rowOf(v, false, "root"))}
          </View>
          {projects.map(projectRow)}
          <Press
            onPress={() => onChooseProject("open")}
            disabled={busy}
            label="open another project"
            title="open another project"
            width="100%"
            height={26}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            gap={8}
            paddingHorizontal={7}
            borderRadius={6}
            box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
          >
            <Glyph width={15}>+</Glyph>
            <Txt register="app-secondary" ellip flex={1} minWidth={0}>
              Open a project…
            </Txt>
          </Press>
        </View>
      )}

      <View
        flexDirection="column"
        gap={1}
        paddingTop={6}
        paddingHorizontal={collapsed ? 0 : 6}
        paddingBottom={6}
        minHeight={0}
        flexShrink={0}
        {...(edge(t, { top: 1 }) as object)}
        {...(collapsed ? { alignItems: "center" } : {})}
      >
        {collapsed ? footer.map((v) => rowOf(v, false)) : null}
        {collapsed ? themeRow : null}
        {settingsPanel ? null : update?.(collapsed)}
        {settingsPanel ? null : rowOf(settings, false, "any", collapsed ? { expand: () => onCollapsed(false) } : undefined)}
      </View>

      {settingsPanel ? (
        <View
          position="absolute"
          left={0}
          right={0}
          top={34}
          bottom={0}
          zIndex={5}
          flexDirection="column"
          minHeight={0}
          paddingTop={4}
          paddingHorizontal={6}
          paddingBottom={6}
          gap={1}
          backgroundColor={t.v("panel-2") as never}
          {...({ boxShadow: t.v("lift") } as object)}
        >
          {rowOf(settings, false, "any", { back: onLeaveSettings })}
          <View flexDirection="column" gap={1} flexShrink={0} marginTop="auto" paddingTop={6} {...(edge(t, { top: 1 }) as object)}>
            {footer.map((v) => rowOf(v, false))}
            {themeRow}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A `.side-row`: the ground that says hovered or on, around the row's target and its verbs. */
function Row({ on, rail, children }: { on: boolean; rail: boolean; children: (hovered: boolean) => ReactNode }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const [hovered, hover] = useHover();
  // The row you are on, as each palette draws it (`:root[data-palette=…] .side-row.on`).
  const onStyle: Record<string, unknown> =
    look.palette === "contrast"
      ? { backgroundColor: "transparent", boxShadow: `inset 0 0 0 1.5px ${String(t.v("rule"))}` }
      : look.palette === "zinc"
        ? look.scheme === "dark"
          ? { backgroundColor: "#191a1d" }
          : { backgroundColor: t.v("panel"), boxShadow: `0 0 0 1px ${String(t.v("line"))}` }
        : { backgroundColor: t.v("tint-accent") };
  const radius = on && (look.palette === "pastel" || look.palette === "pastel-rail") ? 9 : 6;
  return (
    <View
      {...(hover as object)}
      flexDirection="row"
      alignItems="center"
      justifyContent={rail ? "center" : "flex-start"}
      gap={4}
      width={rail ? 34 : "100%"}
      height={26}
      flexShrink={0}
      borderRadius={radius}
      backgroundColor={(hovered ? t.v("fill-ghost-hover") : "transparent") as never}
      {...((on ? onStyle : {}) as object)}
    >
      {children(hovered)}
    </View>
  );
}

/** One project's row: its dot, its name and where it is, its pills, its ⚙ (on hover) and its twisty. */
function ProjectRow({
  p,
  open,
  onProject,
  onProjectSettings,
}: {
  p: SidebarProject;
  open: boolean;
  onProject: (project: string | null) => void;
  onProjectSettings: (project: SidebarProject) => void;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const where = p.where ?? (open ? parentName(p.project) : undefined);
  return (
    <View
      {...(hover as object)}
      flexDirection="row"
      alignItems="center"
      gap={7}
      width="100%"
      flexShrink={0}
      paddingRight={8}
      borderRadius={6}
      backgroundColor={(hovered ? t.v("fill-ghost-hover") : "transparent") as never}
    >
      <Press
        onPress={() => onProject(open ? null : p.project)}
        title={p.project}
        label={p.label}
        flex={1}
        minWidth={0}
        alignSelf="stretch"
        flexDirection="row"
        alignItems="center"
        gap={7}
        paddingTop={open ? 8 : 5}
        paddingBottom={open ? 6 : 5}
        paddingLeft={8}
        borderRadius={6}
      >
        <View width={7} height={7} borderRadius={999} flexShrink={0} backgroundColor={colorOf(t, p.hue) as never} />
        <View flex={1} minWidth={0} flexDirection="row" alignItems="baseline" gap={6}>
          <Txt register={open ? "data-title" : "data-secondary"} ellip flexShrink={0} minWidth={0} maxWidth="100%">
            {p.label}
          </Txt>
          {where !== undefined ? (
            <Txt register="data-faint" ellip flexGrow={1} flexShrink={1} minWidth={0} textAlign="right">
              {where}
            </Txt>
          ) : null}
        </View>
      </Press>
      <Pills counts={p.counts} budget={open ? OPEN_PILL_BUDGET : ROW_PILL_BUDGET} onClear={p.onSeen} />
      {hovered ? (
        <Press onPress={() => onProjectSettings(p)} label={`Settings for ${p.label}`} title={`${p.label}'s settings`} width={20} height={20} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={5} opacity={1}>
          <Glyph scale={11 / 12.5}>⚙</Glyph>
        </Press>
      ) : null}
      {open ? null : (
        <View width={16} height={20} flexShrink={0} alignItems="center" justifyContent="center" pointerEvents="none">
          <Glyph scale={9 / 12.5}>▸</Glyph>
        </View>
      )}
    </View>
  );
}

function RailSplit(): JSX.Element {
  const t = useTokens();
  return <View width={20} height={1} flexShrink={0} marginVertical={2} backgroundColor={t.v("line") as never} />;
}

/** A project in the rail: two letters of its name on a tile, in its hue when the address is on it. */
function RailTile({ p, on, onPress }: { p: SidebarProject; on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const hue = colorOf(t, p.hue);
  return (
    <Press
      onPress={onPress}
      title={p.project}
      label={p.label}
      width={28}
      height={28}
      flexShrink={0}
      borderRadius={8}
      alignItems="center"
      justifyContent="center"
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? hue : "line") as object)}
      backgroundColor={(on ? t.mix(hue, 22, "transparent") : t.v("panel")) as never}
    >
      <Txt spec={{ voice: "data", scale: 0.875, weight: 600, color: on ? "text" : "dim" }}>
        {p.label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "·"}
      </Txt>
    </Press>
  );
}
