import { Fragment, useState, type JSX, type ReactNode } from "react";
import { Linking } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { pressUpdateRow, showsUpdateTip, updateRowTone } from "@jaira/ui/updateRow";
import { publishedWords, sidebarUpdateOf, updateMenu, type UpdateMenu } from "@jaira/ui/updatesModel";
import { applyUpdate, dismissUpdate, refreshBusy, useUpdate } from "@jaira/ui/updatesStore";
import type { UpdateRestartChoice } from "@jaira/shared/browser";
import { Glyph, Press, Txt, edge, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Icon } from "../panel/Icon";
import { anchorRectOf } from "./anchor";
import { Float } from "./Float";
import { TipLayer } from "./TipLayer";

/**
 * `updatesView.tsx`'s `SidebarUpdateRow`, universal (decision 0015): the sidebar's Update row above
 * Settings, drawn only while there is something to do (`sidebarUpdateOf`) — the one click (download if
 * needed, then Wait + update; `updateRow.ts` decides), the × on hover that hides this version, ↻ after a
 * failure, and the chevron for the other ways (`UpdateMenuCard`, beside the row). Hovered, the full
 * version and when it was published stand beside it. In the collapsed rail it is its glyph alone. The
 * rules, from `styles.css`:
 *
 *   .side-row             26 tall, row, centred, gap 4, radius 6; hovered --fill-ghost-hover; .ready
 *                         --tint-accent
 *   .side-hit             the rest of the row: gap 8, padding 0 7; the glyph 15 wide, the label
 *                         app-label — in --accent, --text once ready, --bad after a failure
 *   .upd-side-ver         data 11/12 on a line of 1, --dim, pushed right, at most 58%, one line
 *   .upd-side-bar         44 wide, radius 3, --dim at 16%, filled in --accent to the percent; 6 tall
 *                         (`.um-bar`'s height comes later than the row's 4 and wins)
 *   .side-act             20 square, radius 5, app 11/12.5; .upd-caret / .upd-retry 3 before the edge,
 *                         the chevron 12 (on: --text on --fill-ghost-selected); .upd-dismiss app 14/12.5,
 *                         shown only while the row is under the pointer
 *   .upd-tip              250 wide, padding 8 10, 1px --line, radius 8, --panel, --lift, column gap 3;
 *                         app 11.5/12.5 on 1.4, --dim; its code data 11.5/12 --text, its b --text 600
 */
export function UpdateRow({ collapsed, onOpenAbout, onNotes, onRetry }: { collapsed: boolean; onOpenAbout: () => void; onNotes: () => void; onRetry: () => void }): JSX.Element | null {
  const t = useTokens();
  const { update, busy, queued, restarting } = useUpdate();
  const [hovered, hover] = useHover();
  const [menuAt, setMenuAt] = useState<FloatRect | null | undefined>(undefined);
  const [tipAt, setTipAt] = useState<FloatRect | null>(null);
  const row = sidebarUpdateOf(update, restarting);
  if (row === null || update === null) return null;
  const next = update.available;
  const open = menuAt !== undefined;
  const tone = updateRowTone(row);
  // The label keeps `.app-label`'s --dim whatever the row's state (its own colour beats the hit's); the
  // glyph takes the hit's: --accent, --bad after a failure (`.upd-side.bad .side-glyph`).
  const glyphInk = tone === "bad" ? "bad" : "accent";
  const click = (): void =>
    pressUpdateRow(row, next, { openUrl: (url) => void (isWeb ? window.open(url, "_blank", "noopener") : Linking.openURL(url)), apply: () => applyUpdate("wait"), onOpenAbout });
  const published = publishedWords(next?.releaseDate);
  const act = (label: string, glyph: JSX.Element, onPress: (from: unknown) => void, { on, ...rest }: Record<string, unknown> = {}): JSX.Element => (
    <Press
      key={label}
      onPress={(e) => onPress(isWeb ? (e as unknown as { currentTarget: unknown }).currentTarget : undefined)}
      label={label}
      title={label}
      width={20}
      height={20}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      {...rest}
      box={({ hovered: h }) => ({ backgroundColor: on === true ? t.v("fill-ghost-selected") : h ? t.v("fill-ghost-selected") : "transparent" })}
    >
      {glyph}
    </Press>
  );
  return (
    <View
      {...(hover as object)}
      flexDirection="row"
      alignItems="center"
      justifyContent={collapsed ? "center" : "flex-start"}
      gap={4}
      width={collapsed ? 34 : "100%"}
      height={26}
      flexShrink={0}
      borderRadius={6}
      backgroundColor={(tone === "ready" ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent") as never}
    >
      <Press
        onPress={click}
        disabled={row.kind === "restarting"}
        label={row.title}
        {...(collapsed ? { title: row.title } : {})}
        flex={1}
        minWidth={0}
        alignSelf="stretch"
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingLeft={collapsed ? 0 : 7}
        paddingRight={collapsed ? 0 : 7}
        justifyContent={collapsed ? "center" : "flex-start"}
        borderRadius={6}
        {...((isWeb
          ? {
              onMouseEnter: (e: { currentTarget: unknown }) => setTipAt(anchorRectOf(e.currentTarget)),
              onMouseLeave: () => setTipAt(null),
            }
          : {}) as object)}
      >
        <Glyph width={15} color={glyphInk}>
          {row.glyph}
        </Glyph>
        <Txt register="app-label" ellip flex={1} minWidth={0}>
          {row.label}
        </Txt>
        {collapsed ? null : row.kind === "downloading" ? (
          <>
            <View width={44} height={6} flexShrink={0} marginLeft="auto" borderRadius={3} overflow="hidden" backgroundColor={t.mix(t.v("dim"), 16, "transparent") as never}>
              <View height="100%" width={`${row.percent ?? 0}%`} borderRadius={3} backgroundColor={t.v("accent") as never} />
            </View>
            <Version>
              {row.percent ?? 0}%
            </Version>
          </>
        ) : row.version !== undefined ? (
          <Version auto>{row.version}</Version>
        ) : null}
      </Press>
      {collapsed ? null : (
        <>
          {row.kind === "error" ? act("Check again", <Glyph scale={11 / 12.5} color="dim">↻</Glyph>, onRetry, { marginRight: 3 }) : null}
          {row.dismissible && next !== undefined
            ? act("Hide this update until a newer version", <Glyph scale={14 / 12.5} color="dim">×</Glyph>, () => dismissUpdate(next.version), { opacity: hovered ? 1 : 0 })
            : null}
          {row.menu
            ? act(
                "Other ways to update",
                <Icon name="chevron" size={12} color={String(t.v(open ? "text" : "dim"))} />,
                (from) => {
                  if (!open) refreshBusy();
                  setMenuAt(open ? undefined : anchorRectOf(from));
                },
                { marginRight: 3, on: open },
              )
            : null}
        </>
      )}
      {open ? (
        <UpdateMenuFloat
          anchor={menuAt ?? null}
          menu={updateMenu(update, busy, "sidebar", queued)}
          onPick={(choice) => {
            setMenuAt(undefined);
            applyUpdate(choice);
          }}
          onNotes={() => {
            setMenuAt(undefined);
            onNotes();
          }}
          onClose={() => setMenuAt(undefined)}
        />
      ) : null}
      {tipAt !== null && !open && next !== undefined && showsUpdateTip(row, next) ? (
        <TipLayer>
          <Float anchor={tipAt} side="right" align="start" width={250} flexDirection="column" gap={3} paddingVertical={8} paddingHorizontal={10} borderRadius={8} backgroundColor={t.v("panel")} {...edge(t, { top: 1, right: 1, bottom: 1, left: 1 })} boxShadow={t.v("lift")} pointerEvents="none">
            <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.4 }}>{next.version}</Txt>
            {published !== undefined ? <Txt spec={TIP}>{published}</Txt> : null}
            <Txt spec={TIP}>
              {row.kind === "manual" ? "Click to open the release page" : row.kind === "downloaded" ? "Click to restart" : "Click to update"} · <Txt spec={{ ...TIP, color: "text", weight: 600 }}>×</Txt> hides it until a newer
              version
            </Txt>
          </Float>
        </TipLayer>
      ) : null}
    </View>
  );
}

const TIP = { voice: "app", scale: 11.5 / 12.5, lineHeight: 1.4, color: "dim" } as const;

/** `.upd-side-ver`: data 11/12 on a line of 1, --dim, one line, at most 58%. */
function Version({ auto = false, children }: { auto?: boolean; children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1, color: "dim" }} ellip flexShrink={1} minWidth={0} maxWidth="58%" {...(auto ? { marginLeft: "auto" } : {})}>
      {children}
    </Txt>
  );
}

/**
 * `UpdateMenuCard` in its `Popover` (`.cx-submenu.answer-menu.upd-menu`: 300 wide), beside the row, start
 * aligned: what is going in its head (`.upd-menu-head`: padding 5 8 6, 2 below, a --line under, app
 * 11/12.5 --dim), then the choices — the default ticked — and Release notes.
 */
function UpdateMenuFloat({ anchor, menu, onPick, onNotes, onClose }: { anchor: FloatRect | null; menu: UpdateMenu; onPick: (choice: UpdateRestartChoice) => void; onNotes: () => void; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const box = {
    width: 300,
    flexDirection: "column",
    gap: 1,
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 9,
    backgroundColor: t.v("panel"),
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    role: "menu",
  };
  const body = (
    <>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} paddingTop={5} paddingHorizontal={8} paddingBottom={6} marginBottom={2} {...(edge(t, { bottom: 1 }) as object)}>
        {menu.head}
      </Txt>
      {menu.items.map((item) => (
        <Fragment key={item.name}>
          {item.rule === true ? <View height={1} marginVertical={3} marginHorizontal={4} backgroundColor={t.v("line") as never} /> : null}
          <Press
            onPress={() => (item.kind === "choice" ? onPick(item.choice) : onNotes())}
            flexDirection="row"
            alignItems="flex-start"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={7}
            borderRadius={7}
            box={({ hovered }) => ({ backgroundColor: item.kind === "choice" && item.on === true ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
          >
            {({ hovered }) => (
              <>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
                  {item.kind === "choice" && item.on === true ? "✓" : ""}
                </Txt>
                <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500, lineHeight: 1.25, color: (item.kind === "choice" && item.on === true) || hovered ? "text" : "dim" }} ellip>
                    {item.name}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }}>{item.hint}</Txt>
                </View>
              </>
            )}
          </Press>
        </Fragment>
      ))}
    </>
  );
  return (
    <MenuLayer onClose={onClose}>
      {anchor === null ? (
        <View position="absolute" left={8} right={8} bottom={8} {...(box as object)}>
          {body}
        </View>
      ) : (
        <Float anchor={anchor} side="right" align="start" {...box}>
          {body}
        </Float>
      )}
    </MenuLayer>
  );
}
