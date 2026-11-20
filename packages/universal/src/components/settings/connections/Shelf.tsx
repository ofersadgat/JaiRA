import { useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { AgentInstall, InstallWay } from "@jaira/shared/browser";
import { shelfTileOf, type InstallMenuRow } from "@jaira/ui/connectionsModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { Press, Txt, edge, lengthToken } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { MenuLayer } from "../../MenuLayer";
import { Float } from "../../floats/Float";
import { Icon } from "../../panel/Icon";
import { BrandIcon } from "../bits";
import { Button } from "../Button";
import { useDrawnRow } from "../SettingsPage";
import { SmallButton, Spin, Tag } from "./Row";

/**
 * The shelf under a Connections card: what is not set up yet — an agent or a forge CLI not installed,
 * a server another tool runs, a forge not signed in to — a tile each, a dashed last tile that adds one
 * by hand, and what a tile opened, across the shelf under them. Every section's shelf is drawn of these
 * (`AgentRows.tsx`, `GitRows.tsx`, `McpServerRows.tsx`, `ForgeRows.tsx`). How it looks:
 *
 *   the shelf            column, gap 10, 8 below the card: its head — the title app 600 13/12.5 and,
 *                        with a tile, what the shelf is in --dim at 11.5 — then the tiles, a wrapping
 *                        row, gap 10; then what a tile opened, across
 *   a tile               140 wide, column, gap 8, padding 12, radius --card-radius, 1px --line on
 *                        --panel (chosen: --accent, twice); the mark 17 and the name app 600 12.5/12.5,
 *                        on at most two lines; its line app 11/12.5 --dim; at its foot the one button
 *                        (ghost, app 12/12.5, growing) and, where there are ways, ▾ joined to it
 *   the last tile        dashed 1.5 --rule (open: --accent), centred, gap 3: + in --accent at 17, its
 *                        name app 600 12/12.5, what it takes app 11/12.5 --dim
 *   the ways             a float under ▾ (`MenuLayer`, `Float`): 400 wide, padding 5, --panel, 1px
 *                        --line, radius 8, --lift; its title app 600 11/12.5 --dim, padding 5 10 4; a way
 *                        padding 7 10, radius 6, hovered --tint-accent: its name app 600 12.5/12.5 and
 *                        its tags, over what it runs in the data face 11/12 --dim (what it does, where
 *                        that is words — "installs fnm, then Node.js" — app 11/12.5 --dim), and what
 *                        comes after it ("then …") under that at 11/12.5 --dim; after a --line, the one
 *                        more thing a tile offers
 *   customizing a way    a way whose next step has more than one way is still one row, lit as one,
 *                        ending in a chevron pointing right (12, --dim; open, --accent beside
 *                        `customize` app 11/12.5 --accent), centred in a strip 6 in on each side, padding
 *                        right 4. Hovering the row, or pressing the chevron, opens those ways in a float
 *                        of their own to its right (340 wide, as the first) — and so on, a float a step.
 *                        Pressing the row runs it and the recommended way of each step after; a way
 *                        chosen in a float to the right runs the ways chosen to reach it
 *   what a tile opened   a card (radius 12, 1px --line, --panel), padding 13 16, gap 10: a head (the
 *                        name, app 600, and Done) over what it holds
 */

/** One way under a tile's ▾: its name, what it runs or does, and an optional tag beside the name. */
export interface TileWay {
  key: string;
  name: string;
  at?: string | undefined;
  /** `at` is words, not a command: drawn in the app's face. */
  atWords?: boolean | undefined;
  /** What comes after it, by default: "then npm install -g …". */
  then?: string | undefined;
  tag?: string | undefined;
  /** It asks for an administrator's password, in the system's own window. */
  elevated?: boolean | undefined;
  title?: string | undefined;
  onPress: () => void;
  /** The ways to take the step after it, behind its arrow. */
  sub?: TileWay[] | undefined;
}

/** An install menu's rows as ways under ▾, each pressed to install by its path. */
export function waysOfMenu(rows: readonly InstallMenuRow[], onInstall: (way: InstallWay) => void): TileWay[] {
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    at: row.at,
    atWords: row.words,
    then: row.then,
    ...(row.recommended ? { tag: "recommended" } : {}),
    elevated: row.elevated,
    title: row.title,
    onPress: () => onInstall(row.way),
    ...(row.sub !== undefined ? { sub: waysOfMenu(row.sub, onInstall) } : {}),
  }));
}

/** The shelf: its head, its tiles, and what a tile opened across it. */
export function Shelf({ title, sub, children, across }: { title: string; sub?: string | undefined; children: ReactNode; across?: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" gap={10} marginTop={8}>
      <View flexDirection="row" flexWrap="wrap" alignItems="baseline" columnGap={8} rowGap={2} paddingHorizontal={4}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>{title}</Txt>
        {sub !== undefined ? <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{sub}</Txt> : null}
      </View>
      <View flexDirection="row" flexWrap="wrap" gap={10}>
        {children}
      </View>
      {across}
    </View>
  );
}

const TILE_NAME = { voice: "app", scale: 1, weight: 600 } as const;
const TILE_SUB = { voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.35 } as const;
const TILE_BUTTON = { scale: 12 / 12.5 } as const;

/**
 * One thing not set up: its mark and name, its line, and the one button — with ▾ joined to it when
 * there are ways to choose between. While what it started runs, the button is a spinner and Cancel.
 */
export function Tile({
  brand,
  title,
  sub,
  chosen = false,
  button,
  ways,
  running,
}: {
  brand?: string | undefined;
  title: string;
  sub: string;
  chosen?: boolean;
  button: { label: string; title?: string | undefined; disabled?: boolean; onPress: () => void };
  /** The ▾'s menu: its accessible name, its title, its ways, and one more thing after a line. */
  ways?: { label: string; title: string; items: TileWay[]; busy: boolean; more?: { label: string; onPress: () => void } | undefined; none?: string | undefined } | undefined;
  running?: { words: string; onCancel: () => void } | undefined;
}): JSX.Element {
  const t = useTokens();
  useDrawnRow(true);
  const foot = useRef<RNView | null>(null);
  const [menu, setMenu] = useState<FloatRect | null>(null);
  const openWays = (): void => foot.current?.measureInWindow((x, y, w, h) => setMenu({ left: x, top: y, right: x + w, bottom: y + h }));
  return (
    <View
      width={140}
      flexDirection="column"
      gap={8}
      padding={12}
      borderRadius={lengthToken(t, "card-radius", 10)}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, chosen ? "accent" : "line") as object)}
      {...(chosen ? ({ boxShadow: `inset 0 0 0 1px ${String(t.v("accent"))}` } as object) : {})}
    >
      <View flexDirection="row" alignItems="flex-start" gap={8} minWidth={0}>
        {brand !== undefined ? <BrandIcon name={brand} size={17} /> : null}
        <Txt spec={TILE_NAME} numberOfLines={2} flexShrink={1} minWidth={0} {...({ title } as object)}>
          {title}
        </Txt>
      </View>
      <Txt spec={TILE_SUB}>{running !== undefined ? running.words : sub}</Txt>
      <View marginTop="auto">
        {running !== undefined ? (
          <View flexDirection="row" alignItems="center" gap={6} role="status">
            <Spin />
            <SmallButton kind="ghost" onPress={running.onCancel}>
              Cancel
            </SmallButton>
          </View>
        ) : (
          <RNView ref={foot} collapsable={false} style={{ flexDirection: "row" }}>
            <Button
              kind="ghost"
              flexGrow={1}
              font={TILE_BUTTON}
              paddingHorizontal={6}
              disabled={button.disabled === true}
              {...(button.title !== undefined ? { title: button.title } : {})}
              onPress={button.onPress}
              {...(ways !== undefined ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {})}
            >
              {button.label}
            </Button>
            {ways !== undefined ? (
              <Button
                kind="ghost"
                label={ways.label}
                {...({ "aria-haspopup": "menu", "aria-expanded": menu !== null } as object)}
                onPress={openWays}
                paddingHorizontal={5}
                marginLeft={-1}
                borderTopLeftRadius={0}
                borderBottomLeftRadius={0}
              >
                <Icon name="chevron" size={11} color={String(t.v("text"))} />
              </Button>
            ) : null}
          </RNView>
        )}
      </View>
      {menu !== null && ways !== undefined ? <WaysMenu anchor={menu} {...ways} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/**
 * A tile's ways, each with what it runs, and the one more thing it offers after a line — and, for a
 * way whose next step has more than one way, a float of those to its right, opened by hovering the way
 * or pressing its ›: a float a step.
 */
export function WaysMenu({
  anchor,
  title,
  items,
  busy,
  more,
  none,
  onClose,
}: {
  anchor: FloatRect;
  title: string;
  items: TileWay[];
  busy: boolean;
  more?: { label: string; onPress: () => void } | undefined;
  none?: string | undefined;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  // 400 wide, or the window's width less a margin on a phone.
  const window = useWindowDimensions();
  // The floats open to the right, a step each: where each hangs from, and its ways.
  const [steps, setSteps] = useState<Array<{ from: FloatRect; key: string; items: TileWay[] }>>([]);
  const rows = useRef(new Map<string, RNView | null>());
  /** Open the ways after `way`, at `depth` (the float it is in), closing any further right. */
  const openAfter = (depth: number, way: TileWay, id: string): void => {
    const sub = way.sub;
    if (sub === undefined) {
      setSteps((open) => (open.length > depth ? open.slice(0, depth) : open));
      return;
    }
    rows.current.get(id)?.measureInWindow((x, y, w, h) => setSteps((open) => [...open.slice(0, depth), { from: { left: x, top: y, right: x + w, bottom: y + h }, key: id, items: sub }]));
  };
  const press = (onPress: () => void): void => {
    onClose();
    onPress();
  };
  const item = (key: string, onPress: () => void, disabled: boolean, children: ReactNode, separator = false, title?: string): JSX.Element => (
    <Press
      key={key}
      onPress={() => press(onPress)}
      disabled={disabled}
      {...((isWeb ? { role: "menuitem" } : {}) as object)}
      {...(title !== undefined ? ({ title } as object) : {})}
      flexDirection="column"
      alignItems="flex-start"
      gap={2}
      paddingVertical={7}
      paddingHorizontal={10}
      borderRadius={6}
      {...(separator ? { marginTop: 4 } : {})}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("tint-accent") : "transparent" })}
    >
      {children}
    </Press>
  );
  const wayRow = (way: TileWay, depth: number): JSX.Element => {
    const id = `${depth}:${way.key}`;
    const open = steps[depth]?.key === id;
    // One row: pressed, it installs; its chevron — part of it, lit with it — opens the ways to customize
    // the step after, as hovering it does.
    return (
      <View key={way.key} {...((isWeb ? { onMouseEnter: () => openAfter(depth, way, id) } : {}) as object)}>
        <RNView ref={(el) => void rows.current.set(id, el)} collapsable={false}>
          <Press
            onPress={() => press(way.onPress)}
            disabled={busy}
            {...((isWeb ? { role: "menuitem" } : {}) as object)}
            {...(way.sub !== undefined ? ({ "aria-haspopup": "menu", "aria-expanded": open } as object) : {})}
            {...(way.title !== undefined ? ({ title: way.title } as object) : {})}
            flexDirection="row"
            alignItems="center"
            gap={8}
            paddingVertical={7}
            paddingLeft={10}
            paddingRight={way.sub !== undefined ? 4 : 10}
            borderRadius={6}
            {...(busy ? { opacity: 0.5 } : {})}
            box={({ hovered }) => ({ backgroundColor: (hovered || open) && !busy ? t.v("tint-accent") : "transparent" })}
          >
            <View flexDirection="column" alignItems="flex-start" gap={2} flexGrow={1} flexShrink={1} minWidth={0}>
              <View flexDirection="row" alignItems="center" gap={8} flexWrap="wrap">
                <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{way.name}</Txt>
                {way.tag !== undefined ? <Tag tone="accent">{way.tag}</Tag> : null}
                {way.elevated === true ? <Tag tone="warn">asks for your password</Tag> : null}
              </View>
              {way.at !== undefined ? <Txt spec={way.atWords === true ? { voice: "app", scale: 11 / 12.5, color: "dim" } : { voice: "data", scale: 11 / 12, color: "dim" }}>{way.at}</Txt> : null}
              {way.then !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{way.then}</Txt> : null}
            </View>
            {way.sub !== undefined ? (
              <Press
                onPress={() => openAfter(depth, way, id)}
                label={`customize ${way.name}`}
                title="customize: choose the way for each step"
                fill={false}
                alignSelf="stretch"
                flexDirection="row"
                alignItems="center"
                gap={4}
                paddingHorizontal={6}
                borderRadius={5}
                box={({ hovered }) => ({ backgroundColor: hovered ? t.v("tint-accent") : "transparent" })}
              >
                {open ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }}>customize</Txt> : null}
                <Icon name="chevron" size={12} color={String(t.v(open ? "accent" : "dim"))} box={{ transform: [{ rotate: "-90deg" }] }} />
              </Press>
            ) : null}
          </Press>
        </RNView>
      </View>
    );
  };
  const panel = { padding: 5, backgroundColor: t.v("panel") as never, borderRadius: 8, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object), ...({ boxShadow: t.v("lift") } as object) };
  return (
    <MenuLayer onClose={onClose}>
      <Float anchor={anchor} side="below" align="start" width={Math.min(400, window.width - 16)} flexDirection="column" {...panel} role="menu">
        {items.length > 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "dim" }} paddingTop={5} paddingHorizontal={10} paddingBottom={4}>
            {title}
          </Txt>
        ) : null}
        {items.map((way) => wayRow(way, 0))}
        {items.length > 0 && more !== undefined ? <View height={0} marginTop={4} marginHorizontal={6} {...(edge(t, { top: 1 }) as object)} /> : null}
        {more !== undefined ? item("more", more.onPress, false, <Txt spec={{ voice: "app", scale: 1 }}>{more.label}</Txt>, items.length > 0) : null}
        {items.length === 0 && more === undefined && none !== undefined ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} paddingVertical={7} paddingHorizontal={10}>
            {none}
          </Txt>
        ) : null}
      </Float>
      {steps.map((step, i) => (
        <Float key={step.key} anchor={step.from} side="right" align="start" width={Math.min(340, window.width - 16)} flexDirection="column" {...panel} role="menu">
          {step.items.map((way) => wayRow(way, i + 1))}
        </Float>
      ))}
    </MenuLayer>
  );
}

/**
 * A program not on this machine — an agent, or a forge CLI: Install by the recommended way, the other
 * ways under ▾ with the command each runs. `onSettings` is an agent's way to say where it already is;
 * a tile without one has nothing to set when nothing installs it.
 */
export function InstallTile({
  brand,
  title,
  install,
  running,
  busy,
  chosen,
  onInstall,
  onCancel,
  onSettings,
}: {
  brand: string;
  title: string;
  install: AgentInstall | undefined;
  running: boolean;
  busy: boolean;
  chosen: boolean;
  onInstall: (way: InstallWay | undefined) => void;
  onCancel: () => void;
  onSettings?: (() => void) | undefined;
}): JSX.Element {
  const { sub, ways, menu } = shelfTileOf(install);
  const first = ways[0];
  const wayOf = (row: (typeof ways)[number]): InstallWay | undefined => row.choice ?? row.method;
  return (
    <Tile
      brand={brand}
      title={title}
      sub={sub}
      chosen={chosen}
      {...(running ? { running: { words: "installing — this can take a minute", onCancel } } : {})}
      button={{
        label: first !== undefined || onSettings === undefined ? "Install" : "Set its command",
        ...(first !== undefined ? { title: first.title } : {}),
        disabled: first !== undefined ? busy : onSettings === undefined,
        onPress: () => (first !== undefined ? onInstall(wayOf(first)) : onSettings?.()),
      }}
      ways={{
        label: `ways to install ${title}`,
        title: `Install ${title} with`,
        busy,
        items:
          menu !== undefined
            ? waysOfMenu(menu, onInstall)
            : ways.map((way, i) => ({ key: way.key, name: way.name, at: way.at, title: way.title, ...(i === 0 && ways.length > 1 ? { tag: "recommended" } : {}), onPress: () => onInstall(wayOf(way)) })),
        ...(onSettings !== undefined ? { more: { label: "It is installed elsewhere — set its command…", onPress: onSettings } } : { none: "Nothing on this machine installs it." }),
      }}
    />
  );
}

/** The shelf's last tile: add one by hand. */
export function AnotherTile({ title, sub, open, onPress }: { title: string; sub: string; open: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ "aria-expanded": open } as object)}
      width={140}
      minHeight={104}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={3}
      padding={12}
      borderRadius={lengthToken(t, "card-radius", 10)}
      box={({ hovered }) => ({
        ...edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, open || hovered ? "accent" : "rule", "dashed"),
        borderRadius: lengthToken(t, "card-radius", 10),
        backgroundColor: hovered ? t.v("tint-accent") : "transparent",
      })}
    >
      <Txt spec={{ voice: "app", scale: 17 / 12.5, lineHeight: 1, color: "accent" }} textAlign="center">
        +
      </Txt>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600 }} textAlign="center">
        {title}
      </Txt>
      <Txt spec={TILE_SUB} textAlign="center">
        {sub}
      </Txt>
    </Press>
  );
}

/** What a tile opened, across the shelf: a card with its name and Done. */
export function ShelfCard({ title, onClose, closeLabel = "Done", children }: { title: string; onClose: () => void; closeLabel?: string; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="column"
      gap={10}
      paddingVertical={13}
      paddingHorizontal={16}
      borderRadius={12}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
    >
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} flexGrow={1} flexShrink={1} minWidth={0}>
          {title}
        </Txt>
        <Button kind="quiet" onPress={onClose} font={{ scale: 12 / 12.5 }} paddingVertical={1}>
          {closeLabel}
        </Button>
      </View>
      {children}
    </View>
  );
}
