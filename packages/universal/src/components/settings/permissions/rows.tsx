import { useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import {
  PERMISSION_MODES,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  SMART_FUNCTION,
  isFunctionMode,
  modeFunction,
  type PermissionSet,
  type PermissionSetMode,
  type PlaceKind,
  type SystemArea,
  type ToolCategory,
  type ToolChoice,
  type ToolImplementation,
  type ToolSpec,
} from "@jaira/shared/browser";
import { groupModeOf, groupSentence, groupSummary, runnerFallbackOf, runnerRowsOf, type CommandGroup, type GroupHead, type PlaceRow } from "@jaira/ui/composerPermissionSet";
import { FUNCTION_ICON, MODE_META, RUNNERS_HINT, SCRIPT_HINT, SHELL_HINT, TOOL_ICONS, UNAVAILABLE_META, modeMeta, placeGlyphOf, placeWordsOf } from "@jaira/ui/permissionSetWords";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { NO_STACK, Press, Txt, edge, lengthToken, padToken, useHover } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { MenuLayer } from "../../MenuLayer";
import { Icon, type IconName } from "../../panel/Icon";
import { SchemaForm } from "../../form/SchemaForm";
import { Button } from "../Button";

/**
 * The lines a permission set is drawn as — a tool, a command, a program's fold, the command runners,
 * a section's fold, the mode and implementation menus, and the line that adds one. What each says and
 * every edit are `composerPermissionSet.ts`'s and `permissionSetWords.ts`'s. How they look:
 *
 *   a line               row, centred, gap 4, radius 7; hovered --text 7%; a held line on a page has no
 *                        ground
 *   its words            row, centred, gap 8, padding 5 7, radius 7, grows; --text
 *   an icon              13 square, --tok-hint (a mode's: --bad deny, --ok allow)
 *   a name over a hint   column, gap 1; its name app 500 at 12/12.5 on 1.25; its hint app 10.5/12.5 on 1.3
 *                        --tok-hint; each one line
 *   the mode             a button: --panel-2, 1px --line, radius --control-radius, padding 4 6, gap 5,
 *                        app 11/12.5, --tok-hint; its › at half strength
 *   a custom mode        dashed
 *   the implementation   row, gap 3, padding 2 5, at most 92, 1px --line, radius 5, --tok-hint, app 10.5/12.5
 *   the minus            17 round, 1px --tok-hint, − app 600 at 13 on a line of 1, 2 up; margin 0 2 0 4;
 *                        hovered --bad on --bad 12%
 *   a section            a --line above (not the first); its head a row, centred, gap 4; its fold a row,
 *                        gap 6, padding 5 4, radius 5 (hovered --panel-2): › 10 wide (turned open), the
 *                        words, the count (app 10/12.5, --panel on --accent, radius 8, padding 0 4, at
 *                        least 16 wide)
 *   a section's body     9 in, 7 more, a --line on its left
 *   a program's fold     no line above, head padding 1 0, fold 3 4, body 18 in
 *   the + line           row, centred, gap 9, padding 4 6 4 4, radius 7; + a dashed --tok-hint 17 circle
 *   a menu               column, gap 1, at least 190, padding 4, 1px --line, radius 9, --panel, a 0 10 28
 *                        shadow at 28%; each a row, gap 8, padding 5 7, radius 7, --dim (hovered --text 7%,
 *                        chosen --accent 13%); ✓ 10 wide --ok app 11/12.5; icons 14
 */

const NAME = { voice: "app", scale: 12 / 12.5, weight: 500, lineHeight: 1.25 } as const;
const HINT = { voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" } as const;

/** A 13 icon in its colour. */
export function ChipIcon({ name, color = "tok-hint", size = 13 }: { name: IconName; color?: string; size?: number }): JSX.Element {
  const t = useTokens();
  return <Icon name={name} size={size} color={String(/^[a-z-]+$/.test(color) ? t.v(color) : color)} box={{ flexShrink: 0 }} />;
}

/** A name over a one-line hint. */
export function OptText({ name, hint, mono: _mono = false, nameColor = "text", grow = false }: { name: ReactNode; hint?: ReactNode; mono?: boolean; nameColor?: string; grow?: boolean }): JSX.Element {
  return (
    <View flexDirection="column" gap={1} minWidth={0} flexShrink={1} {...(grow ? { flexGrow: 1 } : {})}>
      {/* `mono` changes nothing here: a command's name is in the app face too. */}
      <Txt spec={{ ...NAME, color: nameColor }} ellip>
        {name}
      </Txt>
      {hint !== undefined ? (
        <Txt spec={HINT} ellip>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** A floating menu, below the box it was opened from and against one of its edges. */
export function SubMenu({ at, align, width, children, onClose }: { at: { x: number; y: number; w: number }; align: "start" | "end"; width: number; children: ReactNode; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const left = align === "end" ? at.x + at.w - width : at.x;
  return (
    <MenuLayer onClose={onClose}>
      <View
        position="absolute"
        left={Math.max(4, Math.min(left, win.width - width - 4))}
        top={at.y + 4}
        minWidth={width}
        flexDirection="column"
        gap={1}
        padding={4}
        borderRadius={9}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: "0 10px 28px rgb(0 0 0 / 28%)" } as object)}
        role="menu"
      >
        {children}
      </View>
    </MenuLayer>
  );
}

/** One row of a menu: ✓, an icon, a name over a hint. */
export function MenuRow({ on = false, icon, name, hint, mono = false, title, onPress }: { on?: boolean; icon?: IconName; name: ReactNode; hint?: string; mono?: boolean; title?: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...(title !== undefined ? { title } : {})}
      {...({ role: "menuitem" } as object)}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={7}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
            {on ? "✓" : ""}
          </Txt>
          {icon !== undefined ? <ChipIcon name={icon} size={14} /> : null}
          <OptText name={name} {...(hint !== undefined ? { hint } : {})} mono={mono} nameColor={on || hovered ? "text" : "dim"} />
        </>
      )}
    </Press>
  );
}

/** Where a box is in the window, for a menu to open under it. */
export function useAnchor(): [React.RefObject<RNView | null>, (then: (at: { x: number; y: number; w: number }) => void) => void] {
  const ref = useRef<RNView | null>(null);
  return [ref, (then) => ref.current?.measureInWindow((x, y, w, h) => then({ x, y: y + h, w }))];
}

/** The red minus that starts a held line: out of the permission set. */
export function RemoveLine({ subject, onRemove }: { subject: string; onRemove: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onRemove}
      title={`remove ${subject}`}
      label={`remove ${subject}`}
      width={17}
      height={17}
      marginTop={0}
      marginRight={2}
      marginBottom={0}
      marginLeft={4}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={999}
      box={({ hovered }) => ({
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: t.v(hovered ? "bad" : "tok-hint"),
        backgroundColor: hovered ? t.mix(t.v("bad"), 12, "transparent") : "transparent",
      })}
    >
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 1, weight: 600, lineHeight: 1, color: hovered ? "bad" : "tok-hint" }} fontSize={13} marginTop={-2} textAlign="center">
          −
        </Txt>
      )}
    </Press>
  );
}

/** The mode control: what happens when this thing is called. */
export function ModePicker({
  mode,
  title,
  onMode,
  readOnly,
  faded = false,
  head = false,
  onRemove,
  removeHint,
  unavailable = false,
  onUnavailable,
  label,
}: {
  mode: PermissionSetMode | undefined;
  title: string;
  onMode: (next: PermissionSetMode) => void;
  readOnly?: boolean | undefined;
  faded?: boolean;
  /** A last row taking the line out of the permission set — for a line with no minus of its own. */
  onRemove?: (() => void) | undefined;
  /** What that row says under `remove`; by default `out of the permission set — not offered`. */
  removeHint?: string | undefined;
  /** The line says `unavailable` (decision 0023 §1): drawn dashed, its eye struck through. */
  unavailable?: boolean;
  /** Offer `unavailable` in the menu — for a tool, the shell and an MCP line only. */
  onUnavailable?: (() => void) | undefined;
  /** What the button reads when there is no `mode` — `elsewhere: as script` — instead of `custom`. */
  label?: string | undefined;
  /**
   * In a fold's head or `Other`'s, not a line: the plain button — padding --control-pad, app 13/12.5 in
   * --text, hovered --panel-3 and --rule — its glyph --tok-hint whatever the mode, its › whole.
   */
  head?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [padV, padH] = padToken(t, "control-pad", [3, 10]);
  const [ref, measure] = useAnchor();
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const meta = unavailable ? UNAVAILABLE_META : mode === undefined ? undefined : modeMeta(mode);
  const ink = unavailable ? "tok-hint" : head ? "text" : mode === "deny" ? "bad" : mode === "allow" ? "ok" : "tok-hint";
  const close = (): void => {
    setAt(null);
    setNaming(false);
  };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => {
          if (readOnly === true) return;
          if (at !== null) close();
          else measure(setAt);
        }}
        title={title}
        {...({ "aria-expanded": at !== null, "aria-disabled": readOnly === true ? true : undefined } as object)}
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        gap={5}
        paddingVertical={head ? padV : 4}
        paddingHorizontal={head ? padH : 6}
        borderWidth={1}
        borderStyle={unavailable || (mode === undefined && label === undefined) ? "dashed" : "solid"}
        borderRadius={lengthToken(t, "control-radius", 7)}
        {...(faded ? { opacity: 0.62 } : {})}
        {...(readOnly === true ? { cursor: "default" } : {})}
        box={({ hovered }) => {
          const hover = hovered && readOnly !== true;
          return head
            ? { borderColor: t.v(hover ? "rule" : "line"), backgroundColor: t.v(hover ? "panel-3" : "panel-2") }
            : { borderColor: t.v("line"), backgroundColor: hover ? t.mix(t.v("text"), 10, "transparent") : t.v("panel-2") };
        }}
      >
        {meta !== undefined ? <ChipIcon name={meta.icon} color={head ? "tok-hint" : ink} /> : null}
        <Txt spec={{ voice: "app", scale: head ? 13 / 12.5 : 11 / 12.5, color: mode === undefined || unavailable ? "tok-hint" : ink }} ellip>
          {meta?.label ?? label ?? "custom"}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} {...(head ? {} : { opacity: 0.5 })}>
          ›
        </Txt>
      </Press>
      {at !== null ? (
        <SubMenu at={at} align="end" width={190} onClose={close}>
          {naming ? (
            <FunctionForm
              initial={modeFunction(mode) ?? SMART_FUNCTION}
              onSet={(reference) => {
                onMode({ function: reference });
                close();
              }}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <>
              {PERMISSION_MODES.map((value) => (
                <MenuRow
                  key={value}
                  on={!unavailable && value === mode}
                  icon={MODE_META[value].icon}
                  name={MODE_META[value].label}
                  hint={MODE_META[value].hint}
                  onPress={() => {
                    onMode(value);
                    close();
                  }}
                />
              ))}
              {onUnavailable !== undefined ? (
                <MenuRow
                  on={unavailable}
                  icon={UNAVAILABLE_META.icon}
                  name={UNAVAILABLE_META.label}
                  hint={UNAVAILABLE_META.hint}
                  onPress={() => {
                    onUnavailable();
                    close();
                  }}
                />
              ) : null}
              <MenuRow
                on={!unavailable && isFunctionMode(mode)}
                icon={FUNCTION_ICON}
                name={isFunctionMode(mode) ? mode.function : "function…"}
                mono={isFunctionMode(mode)}
                hint="a function decides each call, and may ask you — smart, or your own"
                onPress={() => setNaming(true)}
              />
              {onRemove !== undefined ? (
                <MenuRow
                  icon="cross"
                  name="remove"
                  hint={removeHint ?? "out of the permission set — not offered"}
                  onPress={() => {
                    onRemove();
                    close();
                  }}
                />
              ) : null}
            </>
          )}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

/**
 * A mode as a still chip — the mode button's look with nothing to press: its glyph and word, `deny` in
 * --bad, `allow` in --ok, `unavailable` dashed in --tok-hint. Where a mode is read, not set (a table).
 */
export function ModeChip({ mode, unavailable = false }: { mode: PermissionSetMode | undefined; unavailable?: boolean }): JSX.Element {
  const t = useTokens();
  const meta = unavailable ? UNAVAILABLE_META : mode === undefined ? undefined : modeMeta(mode);
  const ink = unavailable || mode === undefined ? "tok-hint" : mode === "deny" ? "bad" : mode === "allow" ? "ok" : isFunctionMode(mode) ? "accent" : "text";
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={5}
      flexShrink={0}
      paddingVertical={2}
      paddingHorizontal={6}
      borderWidth={1}
      borderStyle={unavailable ? "dashed" : "solid"}
      borderColor={t.v("line") as never}
      borderRadius={lengthToken(t, "control-radius", 7)}
      backgroundColor={t.v("panel-2") as never}
      {...({ title: meta?.hint ?? "" } as object)}
    >
      {meta !== undefined ? <ChipIcon name={meta.icon} color={ink} /> : null}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: ink }} ellip>
        {meta?.label ?? "—"}
      </Txt>
    </View>
  );
}

/** Which function decides a line — one string, asked through the schema form. */
export function FunctionForm({ initial, onSet, onCancel }: { initial: string; onSet: (reference: string) => void; onCancel: () => void }): JSX.Element {
  const [typed, setTyped] = useState(initial);
  const schema: Schema = {
    type: "object",
    properties: { function: { type: "string", title: "function", minLength: 1, description: "smart, or a function of your own — a name on the search path, a module symbol, or $BASE/functions/…" } },
    required: ["function"],
  };
  const reference = typed.trim();
  return (
    <View flexDirection="column" gap={6} paddingTop={5} paddingHorizontal={4} paddingBottom={6} width={320}>
      <SchemaForm schema={schema} value={{ function: typed }} onChange={(next) => setTyped(String((next as { function?: unknown } | undefined)?.function ?? ""))} ctx={{ path: "", hidePaths: true }} />
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>It is handed the call and answers allow or deny; to ask you, it calls approve_tool_call.</Txt>
      <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
        <Button kind="ghost" onPress={onCancel} paddingVertical={4} paddingHorizontal={13}>
          Back
        </Button>
        <Button kind="primary" disabled={reference.length === 0} onPress={() => onSet(reference)} paddingVertical={4} paddingHorizontal={13}>
          Set
        </Button>
      </View>
    </View>
  );
}

/** Whose CODE runs this tool — JaiRA's or the agent's own. */
export function ImplPicker({ value, native, nativeHint, onPick, readOnly }: { value: ToolImplementation; native: string; nativeHint?: string | undefined; onPick: (next: ToolImplementation) => void; readOnly?: boolean | undefined }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchor();
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  const options: Array<{ id: ToolImplementation; label: string; hint: string }> = [
    { id: "app", label: "JaiRA", hint: "our implementation, through the artifact map" },
    { id: "native", label: native, hint: nativeHint ?? "the agent's own — still gated by the mode beside it" },
  ];
  const picked = options.find((o) => o.id === value)!;
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => {
          if (readOnly !== true) measure(setAt);
        }}
        title={`Implementation: ${picked.hint}`}
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        gap={3}
        paddingVertical={2}
        paddingHorizontal={5}
        maxWidth={92}
        borderWidth={1}
        borderStyle="solid"
        borderRadius={5}
        box={({ hovered }) => ({ borderColor: t.v("line"), backgroundColor: hovered && readOnly !== true ? t.v("panel-2") : "transparent" })}
      >
        {({ hovered }) => (
          <>
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: hovered && readOnly !== true ? "text" : "tok-hint" }} ellip>
              {picked.label}
            </Txt>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} opacity={0.5}>
              ›
            </Txt>
          </>
        )}
      </Press>
      {at !== null ? (
        <SubMenu at={at} align="end" width={190} onClose={() => setAt(null)}>
          {options.map((option) => (
            <MenuRow
              key={option.id}
              on={option.id === value}
              name={option.label}
              hint={option.hint}
              onPress={() => {
                onPick(option.id);
                setAt(null);
              }}
            />
          ))}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

/** A line's box: hovered, a --text 7% wash. */
function Line({ children, pad }: { children: ReactNode; pad?: number }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View flexDirection="row" alignItems="center" gap={4} borderRadius={7} position="relative" backgroundColor={hovered ? (t.mix(t.v("text"), 7, "transparent") as never) : "transparent"} {...(pad !== undefined ? { paddingLeft: pad } : {})} {...hover}>
      {children}
    </View>
  );
}

/** The words of a line of a permission set on the page: a glyph, a name, a hint. */
function Grant({ icon, name, hint, mono = false, title }: { icon: IconName; name: string; hint: string; mono?: boolean; title?: string }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={7} borderRadius={7} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0} {...(title !== undefined ? ({ title } as object) : {})}>
      <ChipIcon name={icon} />
      <OptText name={name} hint={hint} mono={mono} />
    </View>
  );
}

/**
 * A line's PLACES (decision 0023 §4.2), as the card hands them to a row: the line folds like a command
 * group, and open there is a row per place, most specific first, then `+ add a place`. Every edit is a
 * callback; without them the rows are drawn and nothing can be changed.
 */
export interface LinePlaces {
  kind: PlaceKind;
  /** Most specific first, the line's own `**` last where it has one (`placeRowsOf`). */
  rows: readonly PlaceRow[];
  open: boolean;
  onOpen: () => void;
  /** The words under the line's name: `read a file — 6 places; the most specific decides`. */
  hint: string;
  /** What the head's mode reads where the line has no `**`: `elsewhere: as script`. */
  elsewhere?: string | undefined;
  onPlaceMode?: ((place: string, next: PermissionSetMode) => void) | undefined;
  onRemovePlace?: ((place: string) => void) | undefined;
  /** The last row: a menu of places of the line's kind, and `another…`. Absent where nothing can be added. */
  add?: { label: string; options: readonly AddOption[]; onPick: (id: string) => void; typed: { label: string; example: string; hint: string; onAdd: (typed: string) => string | undefined } } | undefined;
}

/**
 * One place of a line: its minus, the glyph of what it names (a file, a folder, a site, a branch), the
 * place in the data face with a named place's words beside it, and its mode.
 *
 *   the words     row, centred, gap 8, padding 4 7, grows
 *   the place     data 11/12 --text, one line; its words app 10.5/12.5 --tok-hint after it
 */
export function PlaceLine({ kind, row, onMode, onRemove, readOnly }: { kind: PlaceKind; row: PlaceRow; onMode: (next: PermissionSetMode) => void; onRemove?: (() => void) | undefined; readOnly?: boolean | undefined }): JSX.Element {
  const words = placeWordsOf(kind, row.place);
  return (
    <Line>
      {onRemove !== undefined ? <RemoveLine subject={row.place} onRemove={onRemove} /> : null}
      <View flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={7} flexGrow={1} flexShrink={1} minWidth={0} {...({ title: words !== undefined ? `${row.place} — ${words}` : row.place } as object)}>
        <ChipIcon name={placeGlyphOf(kind, row.place)} />
        <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.3 }} ellip flexShrink={1}>
          {row.place}
        </Txt>
        {words !== undefined ? (
          <Txt spec={HINT} ellip flexShrink={2}>
            {words}
          </Txt>
        ) : null}
      </View>
      <ModePicker mode={row.mode} title={`${row.place}: ${modeMeta(row.mode).hint}`} onMode={onMode} readOnly={readOnly} />
    </Line>
  );
}

/** What is under an open line with places: a row per place, then the add row. */
function PlacesBody({ places, readOnly }: { places: LinePlaces; readOnly?: boolean | undefined }): JSX.Element {
  const locked = readOnly === true;
  return (
    <FoldBody sub>
      {places.rows.map((row) => (
        <PlaceLine
          key={row.place}
          kind={places.kind}
          row={row}
          readOnly={locked || places.onPlaceMode === undefined}
          onMode={(next) => places.onPlaceMode?.(row.place, next)}
          onRemove={locked || places.onRemovePlace === undefined ? undefined : () => places.onRemovePlace!(row.place)}
        />
      ))}
      {!locked && places.add !== undefined ? <AddMenu label={places.add.label} options={places.add.options} onPick={places.add.onPick} typed={{ ...places.add.typed, icon: "folder" }} /> : null}
    </FoldBody>
  );
}

/** A line's words: plain, or — with places — the fold that opens onto them. */
function LineWords({ icon, name, hint, mono, places }: { icon: IconName; name: string; hint: string; mono: boolean; places?: LinePlaces | undefined }): JSX.Element {
  if (places === undefined) return <Grant icon={icon} name={name} hint={hint} mono={mono} title={hint} />;
  const n = places.rows.filter((row) => !row.anywhere).length;
  return <Fold open={places.open} onOpen={places.onOpen} icon={icon} name={name} hint={places.hint} mono={mono} {...(n > 0 ? { count: n } : {})} />;
}

/** One tool, as a line of a permission set on the page: its minus, its words, its implementation and mode — and, with places, the rows under it. */
export function ToolRow({
  tool,
  spec,
  mode,
  impl,
  onMode,
  onImpl,
  note,
  onRemove,
  readOnly,
  unavailable = false,
  onUnavailable,
  places,
}: {
  tool: ToolChoice;
  spec?: ToolSpec | undefined;
  /** The line's own mode; absent on a line with places and no `**` — the head then reads {@link LinePlaces.elsewhere}. */
  mode: PermissionSetMode | undefined;
  impl: ToolImplementation;
  onMode: (next: PermissionSetMode) => void;
  onImpl: (next: ToolImplementation) => void;
  note?: string | undefined;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  /** The line says `unavailable`: its mode reads so, and it has no implementation to pick. */
  unavailable?: boolean;
  /** Offer `unavailable` in its mode menu. */
  onUnavailable?: (() => void) | undefined;
  places?: LinePlaces | undefined;
}): JSX.Element {
  const names = Object.entries(tool.natives ?? {});
  const native = names.length > 0 && !unavailable ? "native" : undefined;
  const nativeHint = names.length > 0 ? `the agent's own — ${names.map(([route, name]) => `${name} on ${route}`).join(", ")}` : undefined;
  const hint = note ?? (tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name));
  const line = (
    <Line>
      {onRemove !== undefined ? <RemoveLine subject={spec?.label ?? tool.name} onRemove={onRemove} /> : null}
      <LineWords icon={(TOOL_ICONS[tool.name] ?? "tool") as IconName} name={spec?.label ?? tool.name} hint={hint} mono={false} places={places} />
      {native !== undefined ? <ImplPicker value={impl} native={native} nativeHint={nativeHint} onPick={onImpl} readOnly={readOnly} /> : null}
      <ModePicker
        mode={mode}
        title={`${tool.name}: ${unavailable ? UNAVAILABLE_META.hint : mode !== undefined ? modeMeta(mode).hint : (places?.elsewhere ?? "")}`}
        onMode={onMode}
        readOnly={readOnly}
        unavailable={unavailable}
        onUnavailable={onUnavailable}
        label={places?.elsewhere}
        faded={mode === undefined && places?.elsewhere !== undefined}
      />
    </Line>
  );
  if (places === undefined || !places.open) return line;
  return (
    <View>
      {line}
      <PlacesBody places={places} readOnly={readOnly} />
    </View>
  );
}

/** A line of Execution that is not a tool: a command the permission set names, or `script` — and, with places, the rows under it. */
export function SubjectRow({
  subject,
  hint,
  mode,
  onMode,
  onRemove,
  readOnly,
  follows = false,
  mono,
  icon,
  unavailable = false,
  onUnavailable,
  places,
}: {
  subject: string;
  hint?: string;
  /** The line's own mode; absent on a line with places and no `**`. */
  mode: PermissionSetMode | undefined;
  onMode: (next: PermissionSetMode) => void;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  /** A runner with no line of its own: 23 in, its mode faded. */
  follows?: boolean;
  mono?: boolean;
  icon?: IconName;
  /** An MCP line that says `unavailable`. */
  unavailable?: boolean;
  /** Offer `unavailable` in its mode menu — an MCP line's; a command, `script` and a runner cannot say it. */
  onUnavailable?: (() => void) | undefined;
  places?: LinePlaces | undefined;
}): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  const line = (
    <Line {...(follows && readOnly !== true ? { pad: 23 } : {})}>
      {onRemove !== undefined ? <RemoveLine subject={subject} onRemove={onRemove} /> : null}
      <LineWords icon={icon ?? (script ? "script" : "terminal")} name={subject} hint={hint ?? ""} mono={mono ?? !script} places={places} />
      <ModePicker
        mode={mode}
        title={`${subject}: ${unavailable ? UNAVAILABLE_META.hint : mode !== undefined ? modeMeta(mode).hint : (places?.elsewhere ?? "")}`}
        onMode={onMode}
        readOnly={readOnly}
        faded={follows || (mode === undefined && places?.elsewhere !== undefined)}
        unavailable={unavailable}
        onUnavailable={onUnavailable}
        label={places?.elsewhere}
      />
    </Line>
  );
  if (places === undefined || !places.open) return line;
  return (
    <View>
      {line}
      <PlacesBody places={places} readOnly={readOnly} />
    </View>
  );
}

/**
 * One side of a System area: the tool's name over nothing, then its mode — or, for a side the permission
 * set does not hold, a dashed `add` (nothing at all when the set cannot be changed).
 *
 *   the side      row, centred, gap 6
 *   its name      app 10.5/12.5 --tok-hint, right-aligned in a fixed width so the modes of every area
 *                 stand in one column
 *   its mode      in an 84 box, from its start
 *   add           the mode's box dashed, --tok-hint: + add
 */
function AreaSide({
  tool,
  width,
  held,
  mode,
  onMode,
  onAdd,
  onRemove,
  readOnly,
  unavailable = false,
  onUnavailable,
}: {
  tool: string;
  width: number;
  held: boolean;
  mode: PermissionSetMode;
  onMode: (next: PermissionSetMode) => void;
  onAdd?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  unavailable?: boolean | undefined;
  onUnavailable?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
      <Txt spec={HINT} width={width} textAlign="right" ellip>
        {tool}
      </Txt>
      <View width={84} alignItems="flex-start">
        {held || unavailable ? (
          <ModePicker
            mode={mode}
            title={`${tool}: ${unavailable ? UNAVAILABLE_META.hint : modeMeta(mode).hint}`}
            onMode={onMode}
            readOnly={readOnly}
            onRemove={readOnly === true ? undefined : onRemove}
            unavailable={unavailable}
            onUnavailable={readOnly === true ? undefined : onUnavailable}
          />
        ) : onAdd !== undefined && readOnly !== true ? (
          <Press
            onPress={onAdd}
            title={`add ${tool}`}
            label={`add ${tool}`}
            flexDirection="row"
            alignItems="center"
            gap={5}
            paddingVertical={4}
            paddingHorizontal={6}
            borderWidth={1}
            borderStyle="dashed"
            borderRadius={lengthToken(t, "control-radius", 7)}
            box={({ hovered }) => ({ borderColor: t.v(hovered ? "rule" : "line"), backgroundColor: hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>+ add</Txt>
          </Press>
        ) : (
          <Txt spec={HINT} paddingHorizontal={6}>
            —
          </Txt>
        )}
      </View>
    </View>
  );
}

/** One side of an area as the card hands it over: the tool, whether the set holds it, its mode and edits. */
export interface AreaSideLine {
  tool: string;
  held: boolean;
  /** The side's line says `unavailable`. */
  unavailable?: boolean | undefined;
  onUnavailable?: (() => void) | undefined;
  mode: PermissionSetMode;
  onMode: (next: PermissionSetMode) => void;
  onAdd?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

/**
 * A System area (decision 0019 §1, ruling 1): its minus, its glyph, name and hint, then its look and
 * its change side by side. Each side is its own line of the permission set; the minus takes out both,
 * and a side's mode menu ends with taking out that one.
 *
 *   the row       row, wrapping, centred, gap 4 — the sides drop under the words when they do not fit,
 *                 against the right
 *   the sides     row, centred, gap 10, pushed right
 */
export function AreaRow({ area, look, change, onRemove, readOnly }: { area: SystemArea; look: AreaSideLine; change: AreaSideLine; onRemove?: (() => void) | undefined; readOnly?: boolean | undefined }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={4} borderRadius={7} backgroundColor={hovered ? (t.mix(t.v("text"), 7, "transparent") as never) : "transparent"} {...hover}>
      <View flexDirection="row" alignItems="center" gap={4} flexGrow={1} flexShrink={1} flexBasis={200} minWidth={0}>
        {onRemove !== undefined ? <RemoveLine subject={area.label} onRemove={onRemove} /> : null}
        <Grant icon="system" name={area.label} hint={area.hint} title={area.hint} />
      </View>
      <View flexDirection="row" alignItems="center" gap={10} marginLeft="auto" flexShrink={0}>
        <AreaSide {...look} width={92} readOnly={readOnly} />
        <AreaSide {...change} width={104} readOnly={readOnly} />
      </View>
    </View>
  );
}

/** The count at the end of a fold's head. */
export function Count({ n }: { n: number }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "panel" }} flexShrink={0} minWidth={16} paddingHorizontal={4} borderRadius={8} backgroundColor={t.v("accent") as never} textAlign="center">
      {String(n)}
    </Txt>
  );
}

/** A section's (or a program's) fold head: › , an optional icon, its words, its count. */
function Fold({ open, onOpen, icon, name, hint, mono = false, count, sub = false }: { open: boolean; onOpen: () => void; icon?: IconName; name: string; hint: string; mono?: boolean; count?: number | undefined; sub?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onOpen}
      {...({ "aria-expanded": open } as object)}
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={0}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingVertical={sub ? 3 : 5}
      paddingHorizontal={4}
      borderRadius={5}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} width={10} flexShrink={0} textAlign="center" transform={[{ rotate: open ? "90deg" : "0deg" }]}>
        ›
      </Txt>
      {icon !== undefined ? <ChipIcon name={icon} /> : null}
      <OptText name={name} hint={hint} mono={mono} />
      {count !== undefined ? <Count n={count} /> : null}
    </Press>
  );
}

/** What is under a fold: in from it, a --line on its left. */
export function FoldBody({ children, sub = false }: { children: ReactNode; sub?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View marginLeft={sub ? 18 : 9} paddingLeft={7} {...(edge(t, { left: 1 }) as object)}>
      {children}
    </View>
  );
}

/** One section: what is under it, folded. */
export function CategoryRow({ category, children, granted, open, onOpen, first }: { category: ToolCategory; children: ReactNode; granted: number; open: boolean; onOpen: () => void; first: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0}>
        <Fold open={open} onOpen={onOpen} name={category.label} hint={category.hint} {...(granted > 0 ? { count: granted } : {})} />
      </View>
      {open ? <FoldBody>{children}</FoldBody> : null}
    </View>
  );
}

/** A section with no tool here, or `Other`: a head with nothing to fold (padding 5 0 5 20). */
export function PlainCategory({ name, hint, first, dim = false, control }: { name: string; hint: string; first: boolean; dim?: boolean; control?: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0} paddingVertical={5} paddingLeft={20}>
        <OptText name={name} hint={hint} nameColor={dim ? "tok-hint" : "text"} grow />
        {control}
      </View>
    </View>
  );
}

/** One thing a section does not hold yet, as {@link AddMenu} lists it. */
export interface AddOption {
  subject: string;
  label: string;
  hint?: string | undefined;
  icon?: IconName | undefined;
  mono?: boolean | undefined;
}

/** The `+` line that opens the section's own menu of what it does not hold yet. */
/** A dashed + and a word, in a hint's font. */
export function AddButton({ label, open = false, disabled = false, onPress }: { label: string; open?: boolean; disabled?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      {...(disabled ? { opacity: 0.5 } : {})}
      {...({ "aria-expanded": open } as object)}
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingTop={4}
      paddingRight={6}
      paddingBottom={4}
      paddingLeft={4}
      borderRadius={7}
      alignSelf="flex-start"
      box={({ hovered }) => ({ backgroundColor: (hovered && !disabled) || open ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      <View width={17} height={17} borderRadius={999} alignItems="center" justifyContent="center" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "tok-hint", "dashed") as object)}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600, lineHeight: 1, color: "tok-hint" }} fontSize={13} textAlign="center">
          +
        </Txt>
      </View>
      <Txt spec={HINT}>{label}</Txt>
    </Press>
  );
}

/** The last line of a section or a group: add one of what it does not hold, or type one. */
export function AddMenu({
  label,
  options,
  onPick,
  typed,
}: {
  label: string;
  options: readonly AddOption[];
  onPick: (subject: string) => void;
  /** `another…`: a one-box form. `hint` is what its menu row says (by default `type one, like {example}`), `icon` its glyph. */
  typed?: { label: string; example: string; onAdd: (typed: string) => string | undefined; hint?: string | undefined; icon?: IconName | undefined } | undefined;
}): JSX.Element | null {
  const [ref, measure] = useAnchor();
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  const [typing, setTyping] = useState(false);
  if (options.length === 0 && typed === undefined) return null;
  if (typing && typed !== undefined) return <AddLine label={typed.label} example={typed.example} onAdd={typed.onAdd} startOpen onClose={() => setTyping(false)} />;
  return (
    <View flexDirection="row" alignItems="center" gap={4}>
      <RNView ref={ref} collapsable={false} style={NO_STACK as never}>
        <AddButton label={label} open={at !== null} onPress={() => (options.length === 0 ? setTyping(true) : at !== null ? setAt(null) : measure(setAt))} />
      </RNView>
      {at !== null ? (
        <SubMenu at={at} align="start" width={320} onClose={() => setAt(null)}>
          {options.map((option) => (
            <MenuRow
              key={option.subject}
              title={option.hint ?? option.label}
              icon={option.icon ?? "tool"}
              name={option.label}
              hint={option.hint ?? ""}
              mono={option.mono === true}
              onPress={() => {
                onPick(option.subject);
                setAt(null);
              }}
            />
          ))}
          {typed !== undefined ? (
            <MenuRow
              icon={typed.icon ?? "terminal"}
              name="another…"
              hint={typed.hint ?? `type one, like ${typed.example}`}
              onPress={() => {
                setAt(null);
                setTyping(true);
              }}
            />
          ) : null}
        </SubMenu>
      ) : null}
    </View>
  );
}

/** The one-box form a typed command is added through. */
export function AddLine({ label, example, onAdd, startOpen, onClose }: { label: string; example: string; onAdd: (typed: string) => string | undefined; startOpen?: boolean; onClose?: () => void }): JSX.Element {
  const [open, setOpenState] = useState(startOpen === true);
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) onClose?.();
  };
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const schema: Schema = { type: "object", properties: { command: { type: "string", title: label, minLength: 1, description: `like ${example}` } }, required: ["command"] };
  const add = (): void => {
    const wrong = onAdd(typed);
    setProblem(wrong ?? null);
    if (wrong !== undefined) return;
    setTyped("");
    setOpen(false);
  };
  return (
    <View flexDirection="row" alignItems="center" gap={4}>
      {open ? (
        <View flexDirection="column" gap={6} flexGrow={1} flexShrink={1} minWidth={0} paddingTop={5} paddingHorizontal={4} paddingBottom={6}>
          <SchemaForm schema={schema} value={{ command: typed }} onChange={(next) => setTyped(String((next as { command?: unknown } | undefined)?.command ?? ""))} ctx={{ path: "", hidePaths: true }} />
          {problem !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{problem}</Txt> : null}
          <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
            <Button
              kind="ghost"
              paddingVertical={4}
              paddingHorizontal={13}
              onPress={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
            <Button kind="primary" paddingVertical={4} paddingHorizontal={13} onPress={add}>
              Add
            </Button>
          </View>
        </View>
      ) : (
        <AddButton label={label} open={false} onPress={() => setOpen(true)} />
      )}
    </View>
  );
}

/** The command runners' gate, under Execution: the group's own line, then a row per runner. */
export function RunnerGroupRow({
  permissionSet,
  open,
  onOpen,
  onGroupMode,
  onRunnerMode,
  onRemoveRunner,
  onRemove,
  readOnly,
  placesOf,
}: {
  permissionSet: PermissionSet;
  open: boolean;
  onOpen: () => void;
  onGroupMode: (next: PermissionSetMode) => void;
  onRunnerMode: (program: string, next: PermissionSetMode) => void;
  onRemoveRunner: (program: string) => void;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  /** A runner's own line's places (decision 0023 §4.2), where it has a line. */
  placesOf?: ((program: string) => LinePlaces | undefined) | undefined;
}): JSX.Element {
  const rows = runnerRowsOf(permissionSet);
  const fallback = runnerFallbackOf(permissionSet);
  const named = rows.filter((row) => row.own !== undefined);
  return (
    <View>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0} paddingVertical={1}>
        {onRemove !== undefined ? <View marginLeft={-4}><RemoveLine subject="Command runners" onRemove={onRemove} /></View> : null}
        <Fold sub open={open} onOpen={onOpen} icon="terminal" name="Command runners" hint={open || named.length === 0 ? RUNNERS_HINT : named.map((row) => row.program).join(" · ")} count={rows.length} />
        <ModePicker head mode={fallback} title="Command runners: every runner without a line of its own" onMode={onGroupMode} readOnly={readOnly} />
      </View>
      {open ? (
        <FoldBody sub>
          {rows.map((row) => (
            <SubjectRow
              key={row.program}
              subject={row.program}
              hint={row.hint}
              mode={row.own !== undefined || row.placed !== true ? (row.own ?? fallback) : undefined}
              readOnly={readOnly}
              follows={row.own === undefined && row.placed !== true}
              places={row.own !== undefined || row.placed === true ? placesOf?.(row.program) : undefined}
              onRemove={(row.own !== undefined || row.placed === true) && readOnly !== true ? () => onRemoveRunner(row.program) : undefined}
              onMode={(next) => onRunnerMode(row.program, next)}
            />
          ))}
        </FoldBody>
      ) : null}
    </View>
  );
}

/**
 * One PROGRAM under Execution: a fold over the subcommands the permission set names. Its head is the
 * bare program's line, so it takes places like any line (decision 0023 §4.2): given `places`, open it
 * draws a row per place of the bare line, then its `+ add a place`, above the subcommands. Given `head`
 * (`groupHeadOf`), its mode button claims only what the set writes; without it, it reads the mode any
 * other command of it comes to (`groupModeOf`), as the Tools card's merged view wants.
 */
export function CommandGroupRow({
  group,
  permissionSet,
  open,
  onOpen,
  onMode,
  children,
  onRemove,
  readOnly,
  head,
  places,
}: {
  group: CommandGroup;
  permissionSet: PermissionSet;
  open: boolean;
  onOpen: () => void;
  onMode: (next: PermissionSetMode) => void;
  children: ReactNode;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  head?: GroupHead | undefined;
  /** The bare program's places, where it has a line of its own. */
  places?: LinePlaces | undefined;
}): JSX.Element {
  const locked = readOnly === true;
  const placeRows = places?.rows ?? [];
  const count = group.subs.length + placeRows.filter((row) => !row.anywhere).length;
  return (
    <View>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0} paddingVertical={1}>
        {onRemove !== undefined ? <View marginLeft={-4}><RemoveLine subject={group.program} onRemove={onRemove} /></View> : null}
        <Fold
          sub
          open={open}
          onOpen={onOpen}
          icon="terminal"
          name={group.program}
          mono
          hint={open ? groupSentence(permissionSet, group) : groupSummary(permissionSet, group)}
          {...(count > 0 ? { count } : {})}
        />
        <ModePicker
          head
          mode={head !== undefined ? head.mode : groupModeOf(permissionSet, group)}
          label={head?.label}
          faded={head?.follows === true}
          title={head?.title ?? `${group.program}: any ${group.program} command not named under it`}
          onMode={onMode}
          readOnly={readOnly}
        />
      </View>
      {open ? (
        <FoldBody sub>
          {places !== undefined
            ? placeRows.map((row) => (
                <PlaceLine
                  key={`place:${row.place}`}
                  kind={places.kind}
                  row={row}
                  readOnly={locked || places.onPlaceMode === undefined}
                  onMode={(next) => places.onPlaceMode?.(row.place, next)}
                  onRemove={locked || places.onRemovePlace === undefined ? undefined : () => places.onRemovePlace!(row.place)}
                />
              ))
            : null}
          {places !== undefined && !locked && places.add !== undefined ? (
            <AddMenu label={`${places.add.label} to ${group.program}`} options={places.add.options} onPick={places.add.onPick} typed={{ ...places.add.typed, icon: "folder" }} />
          ) : null}
          {children}
        </FoldBody>
      ) : null}
    </View>
  );
}

export { SCRIPT_HINT, RUNNERS_HINT, SHELL_HINT, TOOL_ICONS };
