import { useMemo, useState, type JSX, type ReactNode } from "react";
import { View as RNView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { PermissionSetTree, PermissionSetTreeRequest, PermissionSetTreeSet, ToolChoice, WritableLayer } from "@jaira/shared/browser";
import { permissionSetIdAt } from "@jaira/shared/browser";
import {
  BROWSER_MODES,
  STACK_BROWSER_MODE,
  browserModeOf,
  collapsedWordsOf,
  contentsNoteOf,
  crumbsOf,
  childrenOf,
  ownSetOf,
  referenceOfPick,
  runtimeMarkOf,
  segmentTitleOf,
  segmentWordsOf,
  setAtOf,
  stackRowsOf,
  treeAtOf,
  treeRowsOf,
  type BrowserMode,
  type CollapsedStack,
  type Crumb,
  type CrumbChoice,
  type LayerSegment,
  type StackPick,
  type StackSegment,
  type TreeAt,
  type TreeRow,
} from "@jaira/ui/composerStack";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { KEEP_WHERE } from "@jaira/ui/composerCards";
import { setIconGlyph } from "@jaira/ui/permissionSetWords";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { useView } from "@jaira/ui/useView";
import { NO_STACK, Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { useShellOrNull, type AppModel } from "../../app/shell";
import { usePhone } from "../../app/phone";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { SchemaForm } from "../form/SchemaForm";
import { Icon, type IconName } from "../panel/Icon";
import { PermissionSetCard } from "../settings/permissions/PermissionSetCard";
import { SubMenu, useAnchorRect } from "./ComposerCards";

/**
 * The composer's permission STACK (decision 0023 §4.1, design 6 of round 8): the Permissions chip as one
 * joined segment per layer, oldest to newest, and what each opens. What it says and every edit are
 * `composerStack.ts`'s; what it reads and writes, `composerStackHost.ts`'s. Render functions: the caller
 * places the bar and opens the cards.
 *
 *   the bar          row, the segments 1 apart; a segment padding 3 9, app 11.5/12.5, --panel-2, --dim
 *                    (hovered --panel-3 and --text; open --accent 13% and --accent); the first rounded on
 *                    its left, the last on its right; the shield cap first, its icon 13 --tok-hint; the
 *                    bottom layer's icon 12 and its ⌄; the tools segment's run answers `· 3` in --accent
 *   collapsed        one segment, round both ends: the shield 13, the bottom layer's icon 12, `+n`
 *   a layer's card   above its segment, 7 apart, 480 wide (expanded: 860, at most the window less 32);
 *                    padding 0 0 2, 1px --line, radius 12, --panel, --lift
 *   its head         row, centred, gap 4, padding 8 9 2 (expanded: 8 9, a --panel-2 rule under it): the
 *                    file glyph (17.6 × 22, 1px, corners 3 8 3 3; --accent and its 10% wash when it is the
 *                    one shown), the crumbs › apart, ⤢ or ⤡ pushed right
 *   a crumb          row, gap 3, padding 2 7, radius 6, data 500 12/12 on 1.5, --dim, ⌄ 12 --dim; open, or
 *                    the one shown in the expanded browser, --accent 13% and --text
 *   the toggle       padding 3 7, 1px --line, radius 6, --panel, --dim app 11/12.5 (expanded: --accent 12%
 *                    and --accent, its edge --accent 50% into --line)
 *   the note         padding 0 9 6, app 10.5/12.5 --tok-hint
 *   the contents     the permission set card, read-only, padding 0 9
 *   the actions      row, wraps, gap 12, padding 7 9 8, a --panel-2 rule above, app 10.5/12.5 --accent;
 *                    `remove` --bad, pushed right
 *   the browser      a grid: the tree 300 wide, a --panel-2 rule on its right, 430 tall, scrolling; the
 *                    contents beside it, scrolling (a phone: the tree over the contents, 180 tall)
 *   a tree row       row, centred, gap 9, padding 6 8, radius 7, 14 in per level; chevron 14, icon 14
 *                    --dim, name app 500 12/12.5 (a bucket and a file in the data face 11.5); selected
 *                    --accent 13%; `in the stack` an --accent 13% tag
 *   the foot         row, gap 8, padding 7 9 9, a --panel-2 rule above: `open in Settings` --tok-hint
 *                    pushed left; Cancel bordered, the verb on --accent
 */

/** One row of the bar's look, measured in the composer's ruler. */
export function StackBar({
  segments,
  collapsed,
  open,
  onOpen,
  onLead,
}: {
  segments: readonly StackSegment[];
  /** Drawn collapsed — the shield, the bottom layer's icon and `+n` — when the composer is too narrow for the segments. */
  collapsed?: CollapsedStack | undefined;
  /** The segment open, by key. */
  open: string | undefined;
  onOpen: (segment: StackSegment, at: FloatRect) => void;
  /** The shield cap: the whole stack. Absent ⇒ the ruler's copy: drawn to be measured, named nothing and pressed by nobody. */
  onLead?: ((at: FloatRect) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const ruler = onLead === undefined;
  if (collapsed !== undefined) {
    const more = collapsedWordsOf(collapsed);
    const lit = open !== undefined;
    return (
      <View flexDirection="row" alignItems="center" flexShrink={0}>
        <Segment t={t} first last on={lit} title={ruler ? undefined : collapsed.title} label={ruler ? undefined : "Permissions"} onPress={onLead}>
          {(hovered) => (
            <>
              <Icon name="shield" size={13} color={String(t.v(lit ? "accent" : "tok-hint"))} />
              {collapsed.icon !== undefined ? <Icon name={setIconGlyph(collapsed.icon)} size={12} color={String(t.v(lit ? "accent" : "tok-hint"))} /> : null}
              {more !== null ? (
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: lit ? "accent" : hovered ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
                  {more}
                </Txt>
              ) : null}
            </>
          )}
        </Segment>
      </View>
    );
  }
  return (
    <View flexDirection="row" alignItems="center" flexShrink={0} {...(ruler ? {} : ({ role: "group", "aria-label": "Permissions" } as object))}>
      <Segment t={t} first last={false} on={open === "lead"} title={ruler ? undefined : "Permissions: everything the stack comes to"} label={ruler ? undefined : "Permissions"} onPress={onLead}>
        {() => <Icon name="shield" size={13} color={String(t.v(open === "lead" ? "accent" : "tok-hint"))} />}
      </Segment>
      {segments.map((segment, i) => {
        const words = segmentWordsOf(segment);
        const mark = runtimeMarkOf(segment);
        const on = open === segment.key;
        const bottom = segment.kind === "layer" && segment.role === "bottom";
        return (
          <Segment key={segment.key} t={t} first={false} last={i === segments.length - 1} on={on} title={ruler ? undefined : segmentTitleOf(segment)} label={ruler ? undefined : segment.kind === "layer" ? segment.id : segment.kind} onPress={ruler ? undefined : (at) => onOpen(segment, at)}>
            {(lit) => (
              <>
                {bottom ? <Icon name={setIconGlyph(segment.icon)} size={12} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
                {segment.kind === "tools" ? <Icon name="tool" size={12} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: on ? "accent" : lit ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
                  {words}
                </Txt>
                {/* The run's answers, in --accent: what this run changed, marked on the lines in the card. */}
                {mark !== null ? (
                  <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600, color: "accent" }} numberOfLines={1} flexShrink={0} marginLeft={-2}>
                    {mark}
                  </Txt>
                ) : null}
                {bottom ? <Icon name="chevron" size={10} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
              </>
            )}
          </Segment>
        );
      })}
    </View>
  );
}

/** One joined segment: measured in the window when pressed, for its card to open against. */
function Segment({ t, first, last, on, title, label, onPress, children }: { t: Tokens; first: boolean; last: boolean; on: boolean; title: string | undefined; label: string | undefined; onPress?: ((at: FloatRect) => void) | undefined; children: (lit: boolean) => ReactNode }): JSX.Element {
  const [ref, measure] = useAnchorRect();
  const radius = { borderTopLeftRadius: first ? 999 : 0, borderBottomLeftRadius: first ? 999 : 0, borderTopRightRadius: last ? 999 : 0, borderBottomRightRadius: last ? 999 : 0 };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, marginLeft: first ? 0 : 1, ...NO_STACK } as never}>
      <Press
        onPress={() => (onPress !== undefined ? measure(onPress) : undefined)}
        {...(title !== undefined ? { title } : {})}
        {...(label !== undefined ? { label } : {})}
        {...({ "aria-expanded": on } as object)}
        {...(onPress === undefined ? { focusable: false } : {})}
        flexDirection="row"
        alignItems="center"
        gap={5}
        paddingVertical={3}
        paddingHorizontal={9}
        // The chips' 1px edge, transparent, so a segment stands as tall as a chip.
        borderWidth={1}
        borderStyle="solid"
        borderColor="transparent"
        {...radius}
        box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.v("panel-3") : t.v("panel-2") })}
      >
        {({ hovered }) => children(hovered || on)}
      </Press>
    </RNView>
  );
}

// --- the cards -----------------------------------------------------------------------------------

/** A stack card's float: above its segment, on --panel with the lifted shadow. */
function StackFloat({ anchor, width, onClose, children }: { anchor: FloatRect; width: number; onClose: () => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="above"
        align="start"
        offset={7}
        width={Math.min(width, win.width - 32)}
        paddingBottom={2}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")) } as object)}
      >
        {children}
      </Float>
    </MenuLayer>
  );
}

/** Where a segment's card reads from and writes to — handed down by the composer. */
export interface StackCardHost {
  /** What a tree read is asked with — `null`: no engine, nothing to browse. */
  treeRequest: PermissionSetTreeRequest | null;
  project: string | undefined;
  tools: readonly ToolChoice[];
}

/** The set file glyph: a page with its corner turned, the set's icon in it. */
function FileGlyph({ icon, on }: { icon: string; on: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexShrink={0}
      width={17.6}
      height={22}
      alignItems="center"
      justifyContent="center"
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v(on ? "accent" : "line") as never}
      borderTopLeftRadius={3}
      borderTopRightRadius={8}
      borderBottomLeftRadius={3}
      borderBottomRightRadius={3}
      backgroundColor={(on ? t.mix(t.v("accent"), 10, t.v("panel")) : t.v("panel")) as never}
    >
      <Icon name={setIconGlyph(icon)} size={12} color={String(t.v(on ? "accent" : "dim"))} />
    </View>
  );
}

/** The ⤢ / ⤡ toggle, remembered (ruling 11). */
function ModeToggle({ mode, onMode }: { mode: BrowserMode; onMode: (next: BrowserMode) => void }): JSX.Element {
  const t = useTokens();
  const expanded = mode === "expanded";
  return (
    <Press
      onPress={() => onMode(expanded ? "compact" : "expanded")}
      title={expanded ? "back to compact — stays until you press it again" : "expand to browse — stays expanded until you press it again"}
      label={expanded ? "Back to compact" : "Expand to browse"}
      marginLeft="auto"
      flexShrink={0}
      paddingVertical={3}
      paddingHorizontal={7}
      borderRadius={6}
      borderWidth={1}
      borderStyle="solid"
      box={({ hovered }) => ({
        borderColor: expanded ? t.mix(t.v("accent"), 50, t.v("line")) : t.v("line"),
        backgroundColor: expanded ? t.mix(t.v("accent"), 12, t.v("panel")) : hovered ? t.v("panel-2") : t.v("panel"),
      })}
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: expanded ? "accent" : "dim" }}>{expanded ? "⤡" : "⤢"}</Txt>
    </Press>
  );
}

/**
 * The crumbs that are pickers (§4.1): each drops what sits beside it, and a folder picked drills into
 * what is in it, so a set is reached from any crumb. `onPick` takes the set chosen; `onFolder`, in the
 * browser, follows a folder chosen. `still`: crumbs to read, not to press.
 */
function CrumbPickers({ tree, crumbs, shownAt, onPick, onFolder, still = false }: { tree: PermissionSetTree; crumbs: readonly Crumb[]; shownAt?: string | undefined; onPick: (choice: CrumbChoice) => void; onFolder?: ((at: TreeAt) => void) | undefined; still?: boolean }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={4} minWidth={0} flexShrink={1}>
      {crumbs.map((crumb, i) => (
        <View key={crumb.key} flexDirection="row" alignItems="center" gap={4}>
          {i > 0 ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>›</Txt> : null}
          <CrumbPicker tree={tree} crumb={crumb} lit={shownAt === crumb.key} onPick={onPick} {...(onFolder !== undefined ? { onFolder } : {})} still={still} />
        </View>
      ))}
    </View>
  );
}

function CrumbPicker({ tree, crumb, lit, onPick, onFolder, still }: { tree: PermissionSetTree; crumb: Crumb; lit: boolean; onPick: (choice: CrumbChoice) => void; onFolder?: (at: TreeAt) => void; still: boolean }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  // What the menu lists: the crumb's siblings, or what is in a folder picked from them.
  const [inside, setInside] = useState<{ label: string; choices: CrumbChoice[] } | null>(null);
  const choices = inside?.choices ?? crumb.siblings;
  const close = (): void => {
    setAt(null);
    setInside(null);
  };
  const choose = (choice: CrumbChoice): void => {
    if (choice.kind === "set") {
      onPick(choice);
      close();
      return;
    }
    onFolder?.(choice.at);
    setInside({ label: choice.label, choices: childrenOf(tree, choice.at) });
  };
  const open = at !== null;
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => (still ? undefined : open ? close() : measure(setAt))}
        title={still ? crumb.label : crumb.kind === "set" ? "the sets beside this one" : crumb.kind === "bucket" ? "the buckets beside this one" : "the scopes"}
        {...(still ? { focusable: false, cursor: "default" } : {})}
        flexDirection="row"
        alignItems="center"
        gap={3}
        paddingVertical={2}
        paddingHorizontal={7}
        borderRadius={6}
        box={({ hovered }) => ({ backgroundColor: open || lit ? t.mix(t.v("accent"), 13, "transparent") : hovered && !still ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
      >
        <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5, color: open || lit ? "text" : "dim" }} numberOfLines={1}>
          {crumb.label}
        </Txt>
        {still ? null : <Icon name="chevron" size={12} color={String(t.v("dim"))} />}
      </Press>
      {at !== null ? (
        <SubMenu anchor={at} align="start" minWidth={240} onClose={close}>
          {inside !== null ? (
            <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={6} paddingHorizontal={8} paddingBottom={2}>
              {inside.label}
            </Txt>
          ) : null}
          {choices.length === 0 ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={6} paddingHorizontal={8}>
              nothing here
            </Txt>
          ) : (
            choices.map((choice) => <ChoiceRow key={choice.key} choice={choice} on={choice.key === crumb.on} onPress={() => choose(choice)} />)
          )}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

/** One row of a crumb's menu: a folder (with › — it opens onto what is in it) or a set file. */
function ChoiceRow({ choice, on, onPress }: { choice: CrumbChoice; on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ role: "menuitem" } as object)}
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingVertical={6}
      paddingHorizontal={8}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {choice.kind === "set" ? <FileGlyph icon={choice.icon} on={on} /> : <Icon name={(choice.kind === "scope" ? choice.icon : "folder") as IconName} size={14} color={String(t.v("dim"))} />}
          <View flexDirection="column" gap={1} minWidth={0} flexGrow={1} flexShrink={1}>
            <Txt spec={{ voice: choice.kind === "scope" ? "app" : "data", scale: choice.kind === "scope" ? 12 / 12.5 : 11.5 / 12, weight: 500, lineHeight: 1.3, color: on || hovered ? "text" : "dim" }} numberOfLines={1}>
              {choice.label}
            </Txt>
            {choice.hint !== undefined ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                {choice.hint}
              </Txt>
            ) : null}
          </View>
          {choice.kind !== "set" ? <Icon name="chevron" size={11} color={String(t.v("dim"))} box={{ transform: [{ rotate: "-90deg" }] }} /> : null}
        </>
      )}
    </Press>
  );
}

/** A set's contents (ruling 10): the card, read-only, drawn from the lines its file writes. */
function SetContents({ host, reference, set }: { host: StackCardHost; reference: string | undefined; set: PermissionSetTreeSet | undefined }): JSX.Element {
  const own = useView("permissionSets:own", host.treeRequest !== null && reference !== undefined ? { reference, ...(host.project !== undefined ? { project: host.project } : {}) } : null);
  const permissionSet = useMemo(() => (own.value !== undefined ? ownSetOf(own.value.lines) : undefined), [own.value]);
  const shown = own.value?.set ?? set;
  return (
    <View flexDirection="column" minWidth={0}>
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.35, color: "tok-hint" }} paddingHorizontal={9} paddingBottom={6}>
        {shown !== undefined ? contentsNoteOf(shown) : own.error !== undefined ? String((own.error as unknown as { message?: string }).message ?? own.error) : "…"}
      </Txt>
      {permissionSet !== undefined ? (
        <View paddingHorizontal={9}>
          {/* A new key per set: what is folded open starts again from what the new one writes. */}
          <PermissionSetCard key={reference} permissionSet={permissionSet} tools={host.tools} readOnly />
        </View>
      ) : null}
    </View>
  );
}

/** A row of the layer's actions: a word in --accent (`remove` in --bad, pushed right). */
function ActionWord({ word, title, bad = false, onPress, disabled = false }: { word: string; title?: string; bad?: boolean; onPress: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Press onPress={onPress} disabled={disabled} {...(title !== undefined ? { title } : {})} {...(bad ? { marginLeft: "auto" } : {})} opacity={disabled ? 0.45 : 1} paddingVertical={1}>
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: bad ? "bad" : hovered && !disabled ? "text" : "accent" }} numberOfLines={1}>
          {word}
        </Txt>
      )}
    </Press>
  );
}

/** What a layer's card can do to its layer. */
export interface LayerActions {
  /** Swap the layer for the set picked. Absent for a standing layer, which settings name. */
  onSwap?: ((reference: string) => void) | undefined;
  onMove?: ((by: -1 | 1) => void) | undefined;
  canEarlier: boolean;
  canLater: boolean;
  /** Pin to the project, or take the pin off. Absent where there is no project to pin to. */
  onPin?: (() => void) | undefined;
  pinned: boolean;
  /** Settings → Tools, where a copy is edited. Absent outside the app. */
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

/**
 * A layer's card (§4.1): compact — the set's path as crumbs that are pickers, its contents, and the
 * layer's actions — or the browser it widens into, the tree beside the contents with the crumbs over
 * both in step with the tree, and `Use as this layer`. The look is remembered (`browserModeOf`).
 */
export function LayerCard({ anchor, segment, host, actions, onClose }: { anchor: FloatRect; segment: LayerSegment; host: StackCardHost; actions: LayerActions; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const [mode, setMode] = useBrowserMode();
  const tree = useView("permissionSets:tree", host.treeRequest).value;
  const at = tree !== undefined ? treeAtOf(tree, segment.reference, segment.id) : undefined;
  if (mode === "expanded" && tree !== undefined) {
    return (
      <SetBrowser
        anchor={anchor}
        tree={tree}
        host={host}
        start={at}
        verb={actions.onSwap !== undefined ? "Use as this layer" : undefined}
        mode={mode}
        onMode={setMode}
        onUse={(reference) => {
          actions.onSwap?.(reference);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }
  const crumbs = tree !== undefined && at !== undefined ? crumbsOf(tree, at) : undefined;
  const set = tree !== undefined ? setAtOf(tree, at) : undefined;
  return (
    <StackFloat anchor={anchor} width={480} onClose={onClose}>
      <View flexDirection="row" alignItems="center" gap={4} paddingTop={8} paddingHorizontal={9} paddingBottom={2}>
        <FileGlyph icon={segment.icon} on />
        {crumbs !== undefined && tree !== undefined ? (
          <CrumbPickers
            tree={tree}
            crumbs={crumbs}
            still={actions.onSwap === undefined}
            onPick={(choice) => {
              const reference = choice.set !== undefined ? referenceOfPick(choice.set) : undefined;
              if (reference !== undefined) actions.onSwap?.(reference);
            }}
          />
        ) : (
          <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={7} numberOfLines={1}>
            {segment.id}
          </Txt>
        )}
        {tree !== undefined ? <ModeToggle mode={mode} onMode={setMode} /> : null}
      </View>
      <View height={6} />
      <View maxHeight={420} {...({ overflowY: "auto" } as object)}>
        <SetContents host={host} reference={segment.reference} set={set} />
      </View>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={12} paddingTop={7} paddingHorizontal={9} paddingBottom={8} marginTop={4} {...(edgeTop(t) as object)}>
        {actions.onMove !== undefined ? (
          <>
            <ActionWord word="‹ earlier" title="Move this layer one earlier — under the one before it" disabled={!actions.canEarlier} onPress={() => actions.onMove?.(-1)} />
            <ActionWord word="later ›" title="Move this layer one later — over the one after it" disabled={!actions.canLater} onPress={() => actions.onMove?.(1)} />
          </>
        ) : null}
        {actions.onPin !== undefined ? (
          <ActionWord
            word={actions.pinned ? "unpin from this project" : "pin to this project"}
            title={actions.pinned ? "Take it off this project's standing layers" : "Keep it in this project's stack for every conversation: a standing layer, in settings"}
            onPress={actions.onPin}
          />
        ) : null}
        {actions.onEdit !== undefined ? <ActionWord word="edit a copy" title="Open it in Settings → Tools; its first change writes this layer's copy" onPress={actions.onEdit} /> : null}
        {actions.onRemove !== undefined ? <ActionWord word="remove" bad title="Take this layer out of the stack" onPress={actions.onRemove} /> : null}
      </View>
    </StackFloat>
  );
}

const edgeTop = (t: Tokens): unknown => edge(t, { top: 1 }, "panel-2");

/**
 * The browser (§4.1): a tree of scopes, buckets and files beside the selected file's contents, the
 * crumbs above both in step with the tree's selection. `verb` presses with the reference picked — `Use as
 * this layer` for a segment, `Lay it on top` for `+`; absent, nothing is picked (a standing layer).
 */
export function SetBrowser({
  anchor,
  tree,
  host,
  start,
  verb,
  mode,
  onMode,
  onUse,
  onClose,
}: {
  anchor: FloatRect;
  tree: PermissionSetTree;
  host: StackCardHost;
  start: TreeAt | undefined;
  verb: string | undefined;
  /** The remembered look — absent for `+`, which is always the browser. */
  mode?: BrowserMode | undefined;
  onMode?: ((next: BrowserMode) => void) | undefined;
  onUse: (reference: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const [selected, setSelected] = useState<TreeAt | undefined>(start);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const rows = treeRowsOf(tree, toggled, selected);
  const crumbs = selected !== undefined ? crumbsOf(tree, selected) : undefined;
  const set = setAtOf(tree, selected);
  const reference = set !== undefined ? referenceOfPick(set) : undefined;
  const select = (at: TreeAt): void => setSelected(at);
  // The panes as tall as the room over the segment leaves, less the head and the foot: 430 at most, 200 at least.
  const paneHeight = Math.max(200, Math.min(430, anchor.top - 7 - 110));
  return (
    <StackFloat anchor={anchor} width={860} onClose={onClose}>
      <View flexDirection="row" alignItems="center" gap={4} paddingVertical={8} paddingHorizontal={9} {...(edge(t, { bottom: 1 }, "panel-2") as object)}>
        <FileGlyph icon={set?.icon ?? "layers"} on={set !== undefined} />
        {crumbs !== undefined ? (
          <CrumbPickers tree={tree} crumbs={crumbs} shownAt={crumbs.at(-1)?.key} onPick={(choice) => choice.set !== undefined && select(choice.at)} onFolder={select} />
        ) : (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "tok-hint" }} paddingHorizontal={7}>
            pick a permission set
          </Txt>
        )}
        {mode !== undefined && onMode !== undefined ? <ModeToggle mode={mode} onMode={onMode} /> : null}
      </View>
      <View flexDirection={phone ? "column" : "row"} height={phone ? undefined : paneHeight} minHeight={0}>
        <View
          {...(phone ? { maxHeight: 180, ...(edge(t, { bottom: 1 }, "panel-2") as object) } : { width: 300, flexShrink: 0, ...(edge(t, { right: 1 }, "panel-2") as object) })}
          paddingVertical={4}
          paddingRight={4}
          paddingLeft={4}
          {...({ overflowY: "auto" } as object)}
        >
          {rows.map((row) => (
            <TreeRowView key={row.key} row={row} onPress={() => (row.kind === "set" ? select(row.at) : setToggled((was) => ({ ...was, [row.key]: !(row.open ?? false) })))} />
          ))}
        </View>
        <View flexGrow={1} flexShrink={1} minWidth={0} paddingTop={7} {...(phone ? { maxHeight: 320 } : {})} {...({ overflowY: "auto" } as object)}>
          {set !== undefined ? (
            <SetContents host={host} reference={set.explicit ?? reference} set={set} />
          ) : (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingHorizontal={9}>
              Pick a set on the left to see what it writes.
            </Txt>
          )}
        </View>
      </View>
      <BrowserFoot host={host} onClose={onClose} close="Cancel">
        {verb !== undefined ? <VerbButton verb={verb} disabled={reference === undefined} onPress={() => reference !== undefined && onUse(reference)} /> : null}
      </BrowserFoot>
    </StackFloat>
  );
}

/** One row of the browser's tree: a scope or a bucket, folding, or a set file with its glyph. */
function TreeRowView({ row, onPress }: { row: TreeRow; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ "aria-expanded": row.kind === "set" ? undefined : row.open } as object)}
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingVertical={row.kind === "set" ? 4 : 6}
      paddingHorizontal={8}
      marginLeft={14 * row.depth}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: row.on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {row.kind !== "set" ? (
        <>
          <Icon name="chevron" size={12} color={String(t.v("dim"))} box={{ transform: [{ rotate: row.open === true ? "0deg" : "-90deg" }] }} />
          <Icon name={(row.kind === "scope" ? row.icon : "folder") as IconName} size={14} color={String(t.v("dim"))} />
          <Txt spec={{ voice: row.kind === "scope" ? "app" : "data", scale: row.kind === "scope" ? 12 / 12.5 : 11.5 / 12, weight: 500 }} numberOfLines={1} flexShrink={1}>
            {row.label}
          </Txt>
          {row.hint !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} marginLeft="auto" numberOfLines={1}>
              {row.hint}
            </Txt>
          ) : null}
        </>
      ) : (
        <>
          <FileGlyph icon={row.icon} on={row.on} />
          <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, lineHeight: 1.3 }} numberOfLines={1}>
              {row.label}
            </Txt>
            {row.hint !== undefined ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                {row.hint}
              </Txt>
            ) : null}
          </View>
          {row.inStack ? <StackTag /> : null}
        </>
      )}
    </Press>
  );
}

/** The browser's foot: `open in Settings` pushed left, then the close button and whatever verbs it is handed. */
function BrowserFoot({ host, onClose, close, children }: { host: StackCardHost; onClose: () => void; close: string; children?: ReactNode }): JSX.Element {
  const t = useTokens();
  const app = useShellOrNull();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="flex-end" gap={8} paddingTop={7} paddingHorizontal={9} paddingBottom={9} {...(edge(t, { top: 1 }, "panel-2") as object)}>
      {app !== null ? (
        <Press
          onPress={() => {
            openSettingsTools(app, host.project);
            onClose();
          }}
          marginRight="auto"
          title="Settings → Tools, where every permission set is edited"
        >
          {({ hovered }) => <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "tok-hint" }}>open in Settings</Txt>}
        </Press>
      ) : (
        <View marginRight="auto" />
      )}
      <Press onPress={onClose} paddingVertical={3} paddingHorizontal={11} borderRadius={7} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never}>
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "dim" }}>{close}</Txt>
      </Press>
      {children}
    </View>
  );
}

/** The browser's verb, on --accent. */
function VerbButton({ verb, disabled, onPress }: { verb: string; disabled: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} disabled={disabled} opacity={disabled ? 0.5 : 1} paddingVertical={3} paddingHorizontal={11} borderRadius={7} backgroundColor={t.v("accent") as never}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "on-accent" }}>{verb}</Txt>
    </Press>
  );
}

/** `in the stack`: a set the stack is built of. */
function StackTag(): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, lineHeight: 1.5, color: "accent" }} flexShrink={0} paddingHorizontal={7} borderRadius={999} backgroundColor={t.mix(t.v("accent"), 13, "transparent") as never} numberOfLines={1}>
      in the stack
    </Txt>
  );
}

/** Settings → Tools, on the layer this window stands on. */
function openSettingsTools(app: AppModel, project: string | undefined): void {
  app.actions.setConfigLayer(project !== undefined ? "project" : "base");
  app.actions.setSection("tools");
  app.actions.setView("settings");
}

/** Settings → Tools, for a caller outside the card (`edit a copy`). */
export function useOpenSettingsTools(project: string | undefined): (() => void) | undefined {
  const app = useShellOrNull();
  return app === null ? undefined : () => openSettingsTools(app, project);
}

/** The remembered look of a layer's card (ruling 11): the window's UI state, else this composer's own. */
export function useBrowserMode(): [BrowserMode, (next: BrowserMode) => void] {
  const app = useShellOrNull();
  const [own, setOwn] = useState<BrowserMode>("compact");
  if (app === null) return [own, setOwn];
  return [browserModeOf(app.state.settings.ui), (next) => app.actions.setMode(STACK_BROWSER_MODE, BROWSER_MODES.includes(next) ? next : "compact")];
}

/** `+` (§4.1): the browser, to pick a set to lay on top of the conversation's layers. */
export function AddLayerCard({ anchor, host, start, onAdd, onClose }: { anchor: FloatRect; host: StackCardHost; start: { reference: string | undefined; id: string } | undefined; onAdd: (reference: string) => void; onClose: () => void }): JSX.Element {
  const tree = useView("permissionSets:tree", host.treeRequest).value;
  if (tree === undefined) {
    return (
      <StackFloat anchor={anchor} width={320} onClose={onClose}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} padding={12}>
          {host.treeRequest === null ? "No permission sets to browse here." : "…"}
        </Txt>
      </StackFloat>
    );
  }
  // Opened on the bottom layer's bucket, with nothing picked: what sits beside it is the likeliest pick.
  const near = start !== undefined ? treeAtOf(tree, start.reference, start.id) : undefined;
  return (
    <SetBrowser
      anchor={anchor}
      tree={tree}
      host={host}
      start={near !== undefined ? { scope: near.scope, bucket: near.bucket } : undefined}
      verb="Lay it on top"
      onUse={(reference) => {
        onAdd(reference);
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/**
 * The shield (2026-11-03): the whole permission picture in the expanded browser. Its tree starts with
 * THIS stack — each layer oldest first, then `tools` — above the scopes. A layer picked shows what its
 * file writes, its crumbs swap it, and its actions are in the foot; `tools` is the Tools card, every
 * line with what this run changed marked; a set picked from a scope can be laid on top.
 */
export function StackBrowser({
  anchor,
  host,
  layers,
  tools,
  runtime,
  actionsOf,
  toolsBody,
  onAdd,
  onClose,
}: {
  anchor: FloatRect;
  host: StackCardHost;
  layers: readonly LayerSegment[];
  /** The tools offered, and the answers this run gave — what the `tools` row says. */
  tools: number;
  runtime: number;
  actionsOf: (layer: LayerSegment) => LayerActions;
  /** The Tools card's body, drawn when `tools` is picked. */
  toolsBody: ReactNode;
  onAdd: (reference: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const phone = usePhone();
  const tree = useView("permissionSets:tree", host.treeRequest).value;
  const [pick, setPick] = useState<StackPick>({ kind: "tools" });
  // The layer picked, found again as the stack moves: by its key, else by what it names.
  const [picked, setPicked] = useState<LayerSegment | undefined>(undefined);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const layer = pick.kind === "layer" ? (layers.find((each) => each.key === pick.key) ?? layers.find((each) => picked !== undefined && each.reference === picked.reference && each.role === picked.role)) : undefined;
  const at = pick.kind === "set" ? pick.at : undefined;
  // Until a set is picked, the bottom layer's bucket stands open: what sits beside it is the likeliest pick.
  const near = tree !== undefined && layers[0] !== undefined ? treeAtOf(tree, layers[0].reference, layers[0].id) : undefined;
  const rows = tree !== undefined ? treeRowsOf(tree, toggled, at ?? (near !== undefined ? { scope: near.scope, bucket: near.bucket } : undefined)) : [];
  const set = tree !== undefined ? setAtOf(tree, at) : undefined;
  const reference = set !== undefined ? referenceOfPick(set) : undefined;
  const layerAt = tree !== undefined && layer !== undefined ? treeAtOf(tree, layer.reference, layer.id) : undefined;
  const actions = layer !== undefined ? actionsOf(layer) : undefined;
  const paneHeight = Math.max(240, Math.min(480, anchor.top - 7 - 110));
  const choose = (next: StackPick, segment?: LayerSegment): void => {
    setPick(next);
    setPicked(segment);
  };
  return (
    <StackFloat anchor={anchor} width={900} onClose={onClose}>
      <View flexDirection="row" alignItems="center" gap={4} paddingVertical={8} paddingHorizontal={9} {...(edge(t, { bottom: 1 }, "panel-2") as object)}>
        {pick.kind === "tools" ? (
          <>
            <Icon name="tool" size={14} color={String(t.v("accent"))} />
            <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={5} numberOfLines={1}>
              tools
            </Txt>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} numberOfLines={1} flexShrink={1}>
              what the whole stack comes to{runtime > 0 ? " — what this run changed is marked" : ""}
            </Txt>
          </>
        ) : layer !== undefined ? (
          <>
            <FileGlyph icon={layer.icon} on />
            {tree !== undefined && layerAt !== undefined ? (
              <CrumbPickers
                tree={tree}
                crumbs={crumbsOf(tree, layerAt)}
                still={actions?.onSwap === undefined}
                onPick={(choice) => {
                  const next = choice.set !== undefined ? referenceOfPick(choice.set) : undefined;
                  if (next !== undefined) actions?.onSwap?.(next);
                }}
              />
            ) : (
              <Txt spec={{ voice: "data", scale: 12 / 12, weight: 500, lineHeight: 1.5 }} paddingHorizontal={7} numberOfLines={1}>
                {layer.id}
              </Txt>
            )}
          </>
        ) : set !== undefined && tree !== undefined && at !== undefined ? (
          <>
            <FileGlyph icon={set.icon} on />
            <CrumbPickers tree={tree} crumbs={crumbsOf(tree, at)} shownAt={crumbsOf(tree, at).at(-1)?.key} onPick={(choice) => choice.set !== undefined && choose({ kind: "set", at: choice.at })} onFolder={(next) => choose({ kind: "set", at: next })} />
          </>
        ) : (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "tok-hint" }} paddingHorizontal={7}>
            pick a layer, the tools, or a permission set
          </Txt>
        )}
      </View>
      <View flexDirection={phone ? "column" : "row"} height={phone ? undefined : paneHeight} minHeight={0}>
        <View
          {...(phone ? { maxHeight: 200, ...(edge(t, { bottom: 1 }, "panel-2") as object) } : { width: 300, flexShrink: 0, ...(edge(t, { right: 1 }, "panel-2") as object) })}
          paddingVertical={4}
          paddingRight={4}
          paddingLeft={4}
          {...({ overflowY: "auto" } as object)}
        >
          {stackRowsOf(layers, tools, runtime).map((row) => {
            const on = row.pick !== undefined && (row.pick.kind === "tools" ? pick.kind === "tools" : row.pick.kind === "layer" && layer !== undefined && row.layer?.key === layer.key);
            if (row.kind === "root") {
              return (
                <View key={row.key} flexDirection="row" alignItems="center" gap={9} paddingVertical={6} paddingHorizontal={8}>
                  <Icon name="shield" size={14} color={String(t.v("dim"))} />
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500 }} numberOfLines={1} flexShrink={1}>
                    {row.label}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} marginLeft="auto" numberOfLines={1}>
                    {row.hint}
                  </Txt>
                </View>
              );
            }
            return (
              <Press
                key={row.key}
                onPress={() => (row.pick !== undefined ? choose(row.pick, row.layer) : undefined)}
                flexDirection="row"
                alignItems="center"
                gap={9}
                paddingVertical={4}
                paddingHorizontal={8}
                marginLeft={14 * row.depth}
                borderRadius={7}
                box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
              >
                {row.kind === "tools" ? <Icon name="tool" size={14} color={String(t.v(on ? "accent" : "dim"))} /> : <FileGlyph icon={row.icon} on={on} />}
                <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, lineHeight: 1.3 }} numberOfLines={1}>
                    {row.label}
                  </Txt>
                  {row.hint !== undefined ? (
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                      {row.hint}
                    </Txt>
                  ) : null}
                </View>
              </Press>
            );
          })}
          <View height={1} marginVertical={5} marginHorizontal={8} backgroundColor={t.v("panel-2") as never} />
          {tree === undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingVertical={6} paddingHorizontal={8}>
              {host.treeRequest === null ? "No permission sets to browse here." : "…"}
            </Txt>
          ) : (
            rows.map((row) => <TreeRowView key={row.key} row={row} onPress={() => (row.kind === "set" ? choose({ kind: "set", at: row.at }) : setToggled((was) => ({ ...was, [row.key]: !(row.open ?? false) })))} />)
          )}
        </View>
        <View flexGrow={1} flexShrink={1} minWidth={0} paddingTop={7} {...(phone ? { maxHeight: 360 } : {})} {...({ overflowY: "auto" } as object)}>
          {pick.kind === "tools" ? (
            <View paddingHorizontal={9} paddingBottom={6}>
              {toolsBody}
            </View>
          ) : layer !== undefined ? (
            <SetContents host={host} reference={layer.reference} set={tree !== undefined ? setAtOf(tree, layerAt) : undefined} />
          ) : set !== undefined ? (
            <SetContents host={host} reference={set.explicit ?? reference} set={set} />
          ) : (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingHorizontal={9}>
              Pick a layer, the tools, or a set on the left.
            </Txt>
          )}
        </View>
      </View>
      <BrowserFoot host={host} onClose={onClose} close="Done">
        {actions !== undefined ? (
          <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={12} marginRight={4}>
            {actions.onMove !== undefined ? (
              <>
                <ActionWord word="‹ earlier" title="Move this layer one earlier — under the one before it" disabled={!actions.canEarlier} onPress={() => actions.onMove?.(-1)} />
                <ActionWord word="later ›" title="Move this layer one later — over the one after it" disabled={!actions.canLater} onPress={() => actions.onMove?.(1)} />
              </>
            ) : null}
            {actions.onPin !== undefined ? <ActionWord word={actions.pinned ? "unpin from this project" : "pin to this project"} onPress={actions.onPin} /> : null}
            {actions.onRemove !== undefined ? (
              <ActionWord
                word="remove"
                bad
                title="Take this layer out of the stack"
                onPress={() => {
                  actions.onRemove?.();
                  choose({ kind: "tools" });
                }}
              />
            ) : null}
          </View>
        ) : null}
        {pick.kind === "set" ? (
          <VerbButton
            verb="Lay it on top"
            disabled={reference === undefined}
            onPress={() => {
              if (reference === undefined) return;
              onAdd(reference);
              choose({ kind: "tools" });
            }}
          />
        ) : null}
      </BrowserFoot>
    </StackFloat>
  );
}

/** `⋯ {n}` (§7.4): the layers folded out of the bar, oldest first; each opens as its own segment would. */
export function FoldCard({ anchor, layers, onOpenLayer, onClose }: { anchor: FloatRect; layers: readonly LayerSegment[]; onOpenLayer: (layer: LayerSegment) => void; onClose: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <StackFloat anchor={anchor} width={340} onClose={onClose}>
      <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={8} paddingHorizontal={10} paddingBottom={2}>
        Folded — oldest first
      </Txt>
      <View flexDirection="column" gap={1} padding={4}>
        {layers.map((layer) => (
          <Press key={layer.key} onPress={() => onOpenLayer(layer)} flexDirection="row" alignItems="center" gap={9} paddingVertical={6} paddingHorizontal={8} borderRadius={7} box={({ hovered }) => ({ backgroundColor: hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}>
            {({ hovered }) => (
              <>
                <Icon name={setIconGlyph(layer.icon)} size={14} color={String(t.v("dim"))} />
                <View flexDirection="column" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                  <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, lineHeight: 1.3, color: hovered ? "text" : "dim" }} numberOfLines={1}>
                    {layer.id}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }} numberOfLines={1}>
                    {[layer.scope, layer.role === "standing" ? "pinned" : undefined, `${layer.lines} ${layer.lines === 1 ? "line" : "lines"}`].filter((each) => each !== undefined).join(" · ")}
                  </Txt>
                </View>
                <Icon name="chevron" size={11} color={String(t.v("dim"))} box={{ transform: [{ rotate: "-90deg" }] }} />
              </>
            )}
          </Press>
        ))}
      </View>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} paddingTop={0} paddingHorizontal={9} paddingBottom={8}>
        Press one to adjust it, as its own segment would.
      </Txt>
    </StackFloat>
  );
}

/** The Tools card's head switch (§7.4, round 6's design 7): `This conversation` | `Everything`. */
export function ToolsSwitch({ everything, onEverything }: { everything: boolean; onEverything: (next: boolean) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={7} overflow="hidden" backgroundColor={t.v("panel") as never} {...({ role: "tablist" } as object)}>
      {[false, true].map((all, i) => {
        const on = everything === all;
        return (
          <Press
            key={String(all)}
            onPress={() => onEverything(all)}
            {...({ role: "tab", "aria-selected": on } as object)}
            paddingVertical={3}
            paddingHorizontal={9}
            {...(i > 0 ? (edge(t, { left: 1 }) as object) : {})}
            box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.v("panel-2") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: on ? 650 : 500, color: on ? "text" : "dim" }} numberOfLines={1}>
              {all ? "Everything" : "This conversation"}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/**
 * "Save this stack as a set" (§7.4), in Everything's head: a name and where it goes, asked through the
 * schema form; `Save` keeps the stack's layers and its tools layer's lines as a file of the bucket.
 */
export function SaveStack({ bucket, layers, onSave }: { bucket: string; layers: readonly WritableLayer[]; onSave: ((name: string, layer: WritableLayer) => Promise<void>) | undefined }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  const [draft, setDraft] = useState<{ name?: string; where?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const where = layers.map((layer) => KEEP_WHERE[layer]);
  const schema: Schema = {
    type: "object",
    properties: { name: { type: "string", title: "name", minLength: 1 }, where: { type: "string", title: "where", enum: where, default: where[0] } },
    required: ["name", "where"],
  };
  const ready = onSave !== undefined && layers.length > 0;
  const save = (): void => {
    const name = (draft.name ?? "").trim();
    const layer = layers.find((candidate) => KEEP_WHERE[candidate] === (draft.where ?? where[0]));
    if (name === "" || layer === undefined || onSave === undefined) {
      setProblem(name === "" ? "name it" : "pick where it goes");
      return;
    }
    setSaving(true);
    setProblem(null);
    void onSave(name, layer).then(
      () => {
        setSaving(false);
        setSaved(permissionSetIdAt(bucket, name));
        setDraft({});
        setAt(null);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, marginLeft: "auto", ...NO_STACK } as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        disabled={!ready}
        title={ready ? `Save this stack as a permission set ${bucket === "" ? "at the top level" : `in ${bucket}`}: its layers, and this conversation's lines` : "There is nowhere to save a set here"}
        paddingHorizontal={7}
        borderRadius={999}
        opacity={ready ? 1 : 0.45}
        backgroundColor={t.mix(t.v("accent"), 13, "transparent") as never}
      >
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.5, color: "accent" }} numberOfLines={1}>
          {saved !== null ? `saved as ${saved}` : "save this stack as a set"}
        </Txt>
      </Press>
      {at !== null && ready ? (
        <SubMenu anchor={at} align="end" minWidth={270} padding={9} gap={7} onClose={() => setAt(null)}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" }}>
            Keep this stack — its layers, and this conversation's lines — as a permission set in <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 700, color: "tok-hint" }}>{bucket}</Txt>
          </Txt>
          <SchemaForm schema={schema} value={{ where: where[0], ...draft }} onChange={(next) => setDraft((next ?? {}) as { name?: string; where?: string })} ctx={{ path: "", hidePaths: true, disabled: saving }} />
          {problem !== null ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} maxWidth={300}>
              {problem}
            </Txt>
          ) : null}
          <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
            <Press onPress={save} disabled={saving} paddingVertical={4} paddingHorizontal={13} borderRadius={7} backgroundColor={t.v("accent") as never} {...(saving ? { opacity: 0.5 } : {})}>
              <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, color: "on-accent" }}>Save</Txt>
            </Press>
          </View>
        </SubMenu>
      ) : null}
    </RNView>
  );
}
