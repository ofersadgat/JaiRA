import { useContext, useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ProbeResult } from "@jaira/shared/browser";
import {
  agentActionOf,
  agentChipOf,
  agentLineOf,
  agentPlaceOf,
  installPanelOf,
  providerSayState,
  settingsGistOf,
  shelfTileOf,
  updateOf,
  useProviderRow,
  type AgentAction,
  type AgentChip,
  type InstallPanelRow,
  type ProviderState,
} from "@jaira/ui/connectionsModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import type { ProviderSpec } from "@jaira/ui/providerSpecs";
import type { ProvidersPaneProps } from "@jaira/ui/providersPaneTypes";
import { Press, Txt, edge, lengthToken } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { MenuLayer } from "../../MenuLayer";
import { Float } from "../../floats/Float";
import { Disclosure } from "../../form/Field";
import { Icon } from "../../panel/Icon";
import { BrandIcon, Hint, Stack } from "../bits";
import { Button } from "../Button";
import { Switch } from "../controls";
import { SettingsLayerContext } from "../layers";
import { SettingsGroup, useDrawnRow } from "../SettingsPage";
import { AddAgentForm, InstallPanel, KeyBoxes, KeyEntry, LoginCards, ProviderForm, UpdateAfter, useShownSpecs } from "./ProviderRows";
import { Chevron, ConnRow, ConnRows, RowHead, Say, SmallButton, Spin, Tag, Version, Wide } from "./Row";

/**
 * Settings → Connections → Agents: the agents on this machine as rows that open in place, then the shelf
 * of the ones it does not have yet (the person, 2026-11-16: "I like 2, but the rows should be able to
 * expand as well"). Which agent goes where, and what a closed row says, is `connectionsModel.ts`'s
 * (`agentPlaceOf`, `agentLineOf`, `agentActionOf`, `agentChipOf`). How it looks:
 *
 *   the card             the section's card (`SettingsGroup`) of `ConnRow`s; not drawn with no row
 *   a closed row         its head (`RowHead`); one line 30 in, app 11.5/12.5, --dim, cut with …: the
 *                        state's word (--bad not working, --warn not signed in, else --text), then
 *                        " · " and the version and how it was installed, or " — " and what the check
 *                        found. In the boxes' place, the one button that would make it work, or the chip
 *                        of who it runs as; then the switch and the chevron
 *   the button           app 12/12.5, primary; while it runs, the spinner, what it waits on (--dim) and
 *                        Cancel
 *   the chip             row, centred, gap 7, padding 3 10 3 3, round, 1px --line on --panel, at most
 *                        300; the mark 20 round, --panel-3 (a login's initial app 600 10px --dim, a key's
 *                        lock 11); who in the data face 11/12, cut with …; the fact app 11/12.5 --dim. A
 *                        key not found: --bad 40% into --line on --tint-bad, the fact --bad
 *   an opened row        the chip and the button go; the head's sentence whole, with its fix (none when
 *                        an install panel is the fix) and the version line with Update; then across it,
 *                        8 apart: the install panel; "Runs as" (app 600 11/12.5 --dim, 6 above the boxes)
 *                        and the login and key boxes, left-aligned, wrapping, 8 apart, 30 in; the key's
 *                        entry; the folded Settings (`Disclosure`) holding the provider's form
 *   the shelf            column, gap 10, 8 below the card: its head — "More agents" app 600 13/12.5 and,
 *                        with a tile, what the shelf is in --dim at 11.5 — then the tiles, a wrapping
 *                        row, gap 10; then what a tile opened, across
 *   a tile               140 wide, column, gap 8, padding 12, radius --card-radius, 1px --line on
 *                        --panel (chosen: --accent, twice); the mark 17 and the name app 600 12.5/12.5,
 *                        on at most two lines;
 *                        what installs it, app 11/12.5 --dim; at its foot Install (ghost, app 12/12.5,
 *                        growing) and ▾ joined to it, which opens the ways
 *   the last tile        dashed 1.5 --rule (open: --accent), centred, gap 3: + in --accent at 17,
 *                        "Another agent CLI" app 600 12/12.5, "any other binary" app 11/12.5 --dim
 *   the ways             a float under ▾ (`MenuLayer`, `Float`): 400 wide, padding 5, --panel, 1px
 *                        --line, radius 8, --lift; its title app 600 11/12.5 --dim, padding 5 10 4; a way
 *                        padding 7 10, radius 6, hovered --tint-accent: its name app 600 12.5/12.5 (the
 *                        first "recommended", an accent tag) over its command in the data face 11/12
 *                        --dim; after a --line, "It is installed elsewhere — set its command…"
 *   what a tile opened   a card (radius 12, 1px --line, --panel), padding 13 16, gap 10: a head (the
 *                        name, app 600, and Done) over the provider's form or the new CLI's
 */

/** Connections → Agents: the card of rows, and the shelf under it. */
export function AgentRows(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element {
  const { config, executorProbes, layer, specs } = props;
  const shown = useShownSpecs(specs);
  if (config === null) {
    return (
      <SettingsGroup>
        <Hint card>The configuration could not be read.</Hint>
      </SettingsGroup>
    );
  }
  const rows = shown.filter((spec) => agentPlaceOf(executorProbes[spec.id]) === "row");
  const shelf = shown.filter((spec) => agentPlaceOf(executorProbes[spec.id]) === "shelf");
  return (
    <>
      {rows.length > 0 ? (
        <SettingsGroup>
          <ConnRows>
            {rows.map((spec, i) => (
              <AgentRow key={`${layer}:${spec.id}`} {...props} first={i === 0} spec={spec} probe={executorProbes[spec.id]} layerDoc={config[layer]} effective={config.effective} />
            ))}
          </ConnRows>
        </SettingsGroup>
      ) : null}
      <AgentShelf {...props} specs={shelf} />
    </>
  );
}

type RowProps = ProvidersPaneProps & { spec: ProviderSpec; probe: ProbeResult | undefined; layerDoc: unknown; effective: unknown };

/** One agent on this machine: a line, one button or chip, the switch and the chevron — and, opened, the rest. */
function AgentRow(props: RowProps & { first: boolean }): JSX.Element {
  const { first, spec, probe, busy, layer, secrets, config, onRemove, onSaveCredential, signingIn, onSignIn, onCancelSignIn, onSignOut, installing, onInstall, onCancelInstall, onUseCommand } = props;
  const [open, setOpen] = useState(false);
  // The key's store form, across the opened row — from its + box, or from the closed row's Add a key.
  const [keyOpen, setKeyOpen] = useState(false);
  const row = useProviderRow(props);
  const { merged, locked, enabled, state, write } = row;
  // How the agent got here and what installs or updates it — while it is on.
  const install = state !== "off" ? probe?.install : undefined;
  const running = installing.has(spec.id);
  const signing = signingIn.has(spec.id);
  const panel = installPanelOf(install);
  const update = updateOf(install);
  const line = agentLineOf(probe, state, install);
  const action = agentActionOf(spec, probe, state, install, merged);
  const chip = agentChipOf(probe, state, merged);
  const agentLogins = probe?.accounts !== undefined && state !== "off";

  const act = (one: AgentAction): void => {
    if (one.kind === "install") {
      if (one.path !== undefined) onUseCommand(spec.id, one.path);
      else onInstall(spec.id, one.method);
    } else if (one.kind === "sign-in") {
      onSignIn(spec.id);
    } else {
      setOpen(true);
      setKeyOpen(true);
    }
  };

  const credentials = [
    ...(agentLogins
      ? LoginCards({
          agent: spec.id,
          command: typeof merged["command"] === "string" ? merged["command"] : undefined,
          accounts: probe!.accounts!,
          signingIn: signing,
          busy,
          warn: state === "needs-sign-in",
          onSignIn: () => onSignIn(spec.id),
          onCancel: () => onCancelSignIn(spec.id),
          onSignOut: () => onSignOut(spec.id),
          ...(spec.credential !== "none" && !keyOpen ? { onAddKey: () => setKeyOpen(true) } : {}),
        })
      : []),
    ...KeyBoxes({ spec, probe, merged, busy: locked, open: keyOpen || agentLogins, warn: state === "needs-sign-in", onOpen: () => setKeyOpen(true) }),
  ];

  // Closed, the one thing beside the switch: what would make it work, or who it runs as. Opened, the
  // row's body has each of them whole.
  const slot = open ? null : action !== undefined ? (
    <ActionSlot
      action={action}
      waiting={action.kind === "install" && running ? { words: "installing…", onCancel: () => onCancelInstall(spec.id) } : action.kind === "sign-in" && signing ? { words: "finish in your browser", onCancel: () => onCancelSignIn(spec.id) } : undefined}
      disabled={action.kind === "install" ? (action.path !== undefined ? locked : busy || running) : action.kind === "sign-in" ? busy : locked}
      onPress={() => act(action)}
    />
  ) : chip !== undefined ? (
    <RunsAs chip={chip} />
  ) : null;

  const wide = open
    ? [
        panel !== undefined ? (
          <Wide key="install">
            <InstallPanel panel={panel} running={running} busy={busy} locked={locked} onInstall={(method) => onInstall(spec.id, method)} onCancel={() => onCancelInstall(spec.id)} onUse={(path) => onUseCommand(spec.id, path)} />
          </Wide>
        ) : null,
        credentials.length > 0 ? (
          <Wide key="as">
            <View marginLeft={30} flexDirection="column" gap={6}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "dim" }}>Runs as</Txt>
              <View flexDirection="row" flexWrap="wrap" gap={8}>
                {credentials}
              </View>
            </View>
          </Wide>
        ) : null,
        keyOpen ? (
          <Wide key="key">
            <KeyEntry spec={spec} merged={merged} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveCredential} onClose={() => setKeyOpen(false)} />
          </Wide>
        ) : null,
        // The form is the provider's own, drawn whole once its fold is open.
        <SettingsLayerContext.Provider key="form" value={null}>
          <Wide body>
            <Disclosure summary="Settings" {...(settingsGistOf(spec) !== undefined ? { desc: settingsGistOf(spec)! } : {})}>
              <Stack>
                <ProviderForm spec={spec} row={row} layer={layer} onRemove={onRemove} />
              </Stack>
            </Disclosure>
          </Wide>
        </SettingsLayerContext.Provider>,
      ]
    : [];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={spec.id} state={state} title={spec.title} />
          {open ? (
            <>
              <Say
                state={state}
                word={providerSayState(probe, state)}
                detail={probe && state !== "off" && probe.detail ? probe.detail : undefined}
                // An install panel is the fix, with the command it runs: its sentence would only point at it.
                fix={probe && state !== "off" && probe.fix && panel === undefined ? probe.fix : undefined}
              />
              {probe?.version ? (
                <Version after={update !== undefined ? <UpdateAfter via={update.via} title={update.title} running={running} disabled={busy} onUpdate={() => onInstall(spec.id)} onCancel={() => onCancelInstall(spec.id)} /> : undefined}>{probe.version}</Version>
              ) : null}
            </>
          ) : (
            <AgentLine state={state} word={line.word} rest={line.rest} />
          )}
        </>
      }
      // An empty slot where there is nothing: ConnRow pulls the controls 14 in without one, and an agent
      // row's switch keeps one column down the card, open or closed.
      boxes={[slot ?? <View key="none" />]}
      controls={
        <>
          <Switch
            on={enabled}
            label={enabled ? `stop using ${spec.title} in this project` : `use ${spec.title} again`}
            disabled={locked}
            // `undefined` REMOVES the key rather than writing `true`: on is the default.
            onChange={(next) => write({ enabled: next ? undefined : false })}
          />
          <Chevron
            open={open}
            label={open ? `close ${spec.title}` : `open ${spec.title}`}
            tips={["Show more", "Show less"]}
            onPress={() => {
              if (open) setKeyOpen(false);
              setOpen(!open);
            }}
          />
        </>
      }
      wide={wide}
    />
  );
}

const LINE = { voice: "app", scale: 11.5 / 12.5, color: "dim" } as const;

/** A closed row's one line: the state's word, then its version or what the check found. */
function AgentLine({ state, word, rest }: { state: ProviderState; word: string; rest: string | undefined }): JSX.Element {
  const whole = rest !== undefined ? `${word}${state === "available" ? " · " : " — "}${rest}` : word;
  return (
    <Txt spec={LINE} paddingLeft={30} numberOfLines={1} {...({ title: whole } as object)}>
      <Txt spec={{ ...LINE, color: state === "unavailable" ? "bad" : state === "needs-sign-in" ? "warn" : "text" }}>{word}</Txt>
      {rest !== undefined ? (state === "available" ? " · " : " — ") : null}
      {rest !== undefined ? rest : null}
    </Txt>
  );
}

/** The closed row's button — or, while what it started runs, the spinner, what it waits on, and Cancel. */
function ActionSlot({ action, waiting, disabled, onPress }: { action: AgentAction; waiting: { words: string; onCancel: () => void } | undefined; disabled: boolean; onPress: () => void }): JSX.Element {
  if (waiting !== undefined) {
    return (
      <View flexDirection="row" alignItems="center" gap={6} role="status" paddingTop={1}>
        <Spin />
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{waiting.words}</Txt>
        <SmallButton kind="ghost" onPress={waiting.onCancel}>
          Cancel
        </SmallButton>
      </View>
    );
  }
  return (
    <Button kind="primary" disabled={disabled} title={action.title} onPress={onPress} font={{ scale: 12 / 12.5 }} paddingVertical={2}>
      {action.label}
    </Button>
  );
}

/** Who a closed row runs as: the login in use, or the key and where it was found. */
function RunsAs({ chip }: { chip: AgentChip }): JSX.Element {
  const t = useTokens();
  const missing = chip.kind === "key" && chip.missing;
  const fact = chip.kind === "login" ? [chip.fact, chip.more > 0 ? `+${chip.more}` : undefined].filter((part) => part !== undefined).join(" · ") : chip.where;
  const who = chip.kind === "login" ? chip.who : chip.name;
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={7}
      paddingVertical={3}
      paddingLeft={3}
      paddingRight={10}
      borderRadius={999}
      maxWidth={300}
      minWidth={0}
      backgroundColor={t.v(missing ? "tint-bad" : "panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, missing ? t.mix(t.v("bad"), 40, t.v("line")) : "line") as object)}
    >
      <View width={20} height={20} flexShrink={0} borderRadius={999} alignItems="center" justifyContent="center" backgroundColor={t.v("panel-3") as never}>
        {chip.kind === "login" ? (
          <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, color: "dim", lineHeight: { px: 14 } }} textAlign="center">
            {chip.who.charAt(0).toUpperCase()}
          </Txt>
        ) : (
          <Icon name="lock" size={11} color={String(t.v("dim"))} />
        )}
      </View>
      <Txt spec={{ voice: "data", scale: 11 / 12 }} numberOfLines={1} flexShrink={1} minWidth={0} {...({ title: who } as object)}>
        {who}
      </Txt>
      {fact !== undefined && fact !== "" ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: missing ? "bad" : "dim" }} numberOfLines={1} flexShrink={0}>
          {fact}
        </Txt>
      ) : null}
    </View>
  );
}

// --- the shelf ----------------------------------------------------------------------------------

type Opened = { kind: "add" } | { kind: "settings"; id: string } | null;

/** The agents this machine does not have yet, a tile each, and the tile that adds another CLI. */
function AgentShelf(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element | null {
  const { specs, config, executorProbes, busy, editable, layer, installing, onInstall, onCancelInstall, onAdd } = props;
  // Adding is setting something, which "What you changed" is not showing.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  const [opened, setOpened] = useState<Opened>(null);
  if (specs.length === 0 && onlyStated) return null;
  const settingsOf = opened?.kind === "settings" ? specs.find((spec) => spec.id === opened.id) : undefined;
  return (
    <View flexDirection="column" gap={10} marginTop={8}>
      <View flexDirection="row" flexWrap="wrap" alignItems="baseline" columnGap={8} rowGap={2} paddingHorizontal={4}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>More agents</Txt>
        {specs.length > 0 ? <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>not on this machine yet — none is used until it is installed</Txt> : null}
      </View>
      <View flexDirection="row" flexWrap="wrap" gap={10}>
        {specs.map((spec) => (
          <ShelfTile
            key={`${layer}:${spec.id}`}
            spec={spec}
            probe={executorProbes[spec.id]}
            running={installing.has(spec.id)}
            busy={busy}
            chosen={opened?.kind === "settings" && opened.id === spec.id}
            onInstall={(way) => onInstall(spec.id, way)}
            onCancel={() => onCancelInstall(spec.id)}
            onSettings={() => setOpened({ kind: "settings", id: spec.id })}
          />
        ))}
        {onlyStated ? null : <AnotherTile open={opened?.kind === "add"} onPress={() => setOpened((was) => (was?.kind === "add" ? null : { kind: "add" }))} />}
      </View>
      {opened?.kind === "add" ? (
        <ShelfCard title="Another agent CLI" onClose={() => setOpened(null)}>
          <AddAgentForm layer={layer} busy={busy || !editable} onAdd={onAdd} onClose={() => setOpened(null)} />
        </ShelfCard>
      ) : null}
      {settingsOf !== undefined && config !== null ? (
        <ShelfSettings key={`${layer}:${settingsOf.id}`} {...props} spec={settingsOf} probe={executorProbes[settingsOf.id]} layerDoc={config[layer]} effective={config.effective} onClose={() => setOpened(null)} />
      ) : null}
    </View>
  );
}

const TILE_NAME = { voice: "app", scale: 1, weight: 600 } as const;
const TILE_SUB = { voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.35 } as const;
const TILE_BUTTON = { scale: 12 / 12.5 } as const;

/** One agent not on this machine: its name, what installs it, and Install with the other ways under ▾. */
function ShelfTile({
  spec,
  probe,
  running,
  busy,
  chosen,
  onInstall,
  onCancel,
  onSettings,
}: {
  spec: ProviderSpec;
  probe: ProbeResult | undefined;
  running: boolean;
  busy: boolean;
  chosen: boolean;
  onInstall: (way: InstallPanelRow["method"]) => void;
  onCancel: () => void;
  onSettings: () => void;
}): JSX.Element {
  const t = useTokens();
  useDrawnRow(true);
  const { sub, ways } = shelfTileOf(probe?.install);
  const first = ways[0];
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
        <BrandIcon name={spec.id} size={17} />
        <Txt spec={TILE_NAME} numberOfLines={2} flexShrink={1} minWidth={0} {...({ title: spec.title } as object)}>
          {spec.title}
        </Txt>
      </View>
      <Txt spec={TILE_SUB}>{running ? "installing — this can take a minute" : sub}</Txt>
      <View marginTop="auto">
        {running ? (
          <View flexDirection="row" alignItems="center" gap={6} role="status">
            <Spin />
            <SmallButton kind="ghost" onPress={onCancel}>
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
              disabled={first !== undefined && busy}
              {...(first !== undefined ? { title: first.title } : {})}
              onPress={() => (first !== undefined ? onInstall(first.method) : onSettings())}
              borderTopRightRadius={0}
              borderBottomRightRadius={0}
            >
              {first !== undefined ? "Install" : "Set its command"}
            </Button>
            <Button
              kind="ghost"
              label={`ways to install ${spec.title}`}
              {...({ "aria-haspopup": "menu", "aria-expanded": menu !== null } as object)}
              onPress={openWays}
              paddingHorizontal={5}
              marginLeft={-1}
              borderTopLeftRadius={0}
              borderBottomLeftRadius={0}
            >
              <Icon name="chevron" size={11} color={String(t.v("text"))} />
            </Button>
          </RNView>
        )}
      </View>
      {menu !== null ? <WaysMenu anchor={menu} title={spec.title} ways={ways} busy={busy} onPick={(way) => onInstall(way.method)} onSettings={onSettings} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** The ways to install an agent, each with the command it runs, and the way to point at one already here. */
function WaysMenu({
  anchor,
  title,
  ways,
  busy,
  onPick,
  onSettings,
  onClose,
}: {
  anchor: FloatRect;
  title: string;
  ways: InstallPanelRow[];
  busy: boolean;
  onPick: (way: InstallPanelRow) => void;
  onSettings: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  // 400 wide, or the window's width less a margin on a phone.
  const window = useWindowDimensions();
  const item = (key: string, onPress: () => void, disabled: boolean, children: ReactNode, separator = false): JSX.Element => (
    <Press
      key={key}
      onPress={() => {
        onClose();
        onPress();
      }}
      disabled={disabled}
      {...((isWeb ? { role: "menuitem" } : {}) as object)}
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
  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="below"
        align="start"
        width={Math.min(400, window.width - 16)}
        flexDirection="column"
        padding={5}
        backgroundColor={t.v("panel") as never}
        borderRadius={8}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: t.v("lift") } as object)}
        role="menu"
      >
        {ways.length > 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "dim" }} paddingTop={5} paddingHorizontal={10} paddingBottom={4}>
            {`Install ${title} with`}
          </Txt>
        ) : null}
        {ways.map((way, i) =>
          item(
            way.key,
            () => onPick(way),
            busy,
            <>
              <View flexDirection="row" alignItems="center" gap={8}>
                <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{way.name}</Txt>
                {i === 0 && ways.length > 1 ? <Tag tone="accent">recommended</Tag> : null}
              </View>
              <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{way.at}</Txt>
            </>,
          ),
        )}
        {ways.length > 0 ? <View height={0} marginTop={4} marginHorizontal={6} {...(edge(t, { top: 1 }) as object)} /> : null}
        {item("command", onSettings, false, <Txt spec={{ voice: "app", scale: 1 }}>It is installed elsewhere — set its command…</Txt>, ways.length > 0)}
      </Float>
    </MenuLayer>
  );
}

/** The shelf's last tile: declare any other agent CLI. */
function AnotherTile({ open, onPress }: { open: boolean; onPress: () => void }): JSX.Element {
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
        Another agent CLI
      </Txt>
      <Txt spec={TILE_SUB} textAlign="center">
        any other binary
      </Txt>
    </Press>
  );
}

/** What a tile opened, across the shelf: a card with its name and Done. */
function ShelfCard({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
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
          Done
        </Button>
      </View>
      {children}
    </View>
  );
}

/** A shelf agent's own settings — its command above all, for one installed where nothing looked. */
function ShelfSettings(props: RowProps & { onClose: () => void }): JSX.Element {
  const { spec, layer, onRemove, onClose } = props;
  const row = useProviderRow(props);
  return (
    <ShelfCard title={`${spec.title} settings`} onClose={onClose}>
      <SettingsLayerContext.Provider value={null}>
        <ProviderForm spec={spec} row={row} layer={layer} onRemove={onRemove} />
      </SettingsLayerContext.Provider>
    </ShelfCard>
  );
}
