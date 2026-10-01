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
  type ToolCategory,
  type ToolChoice,
  type ToolImplementation,
  type ToolSpec,
} from "@jaira/shared/browser";
import { groupModeOf, groupSentence, groupSummary, runnerFallbackOf, runnerRowsOf, type CommandGroup } from "@jaira/ui/composerPermissionSet";
import { FUNCTION_ICON, MODE_META, RUNNERS_HINT, SCRIPT_HINT, SHELL_HINT, TOOL_ICONS, modeMeta } from "@jaira/ui/permissionSetWords";
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
function SubMenu({ at, align, width, children, onClose }: { at: { x: number; y: number; w: number }; align: "start" | "end"; width: number; children: ReactNode; onClose: () => void }): JSX.Element {
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
function MenuRow({ on = false, icon, name, hint, mono = false, title, onPress }: { on?: boolean; icon?: IconName; name: ReactNode; hint?: string; mono?: boolean; title?: string; onPress: () => void }): JSX.Element {
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
function useAnchor(): [React.RefObject<RNView | null>, (then: (at: { x: number; y: number; w: number }) => void) => void] {
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
}: {
  mode: PermissionSetMode | undefined;
  title: string;
  onMode: (next: PermissionSetMode) => void;
  readOnly?: boolean | undefined;
  faded?: boolean;
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
  const meta = mode === undefined ? undefined : modeMeta(mode);
  const ink = head ? "text" : mode === "deny" ? "bad" : mode === "allow" ? "ok" : "tok-hint";
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
        borderStyle={mode === undefined ? "dashed" : "solid"}
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
        <Txt spec={{ voice: "app", scale: head ? 13 / 12.5 : 11 / 12.5, color: mode === undefined ? "tok-hint" : ink }} ellip>
          {meta?.label ?? "custom"}
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
                  on={value === mode}
                  icon={MODE_META[value].icon}
                  name={MODE_META[value].label}
                  hint={MODE_META[value].hint}
                  onPress={() => {
                    onMode(value);
                    close();
                  }}
                />
              ))}
              <MenuRow
                on={isFunctionMode(mode)}
                icon={FUNCTION_ICON}
                name={isFunctionMode(mode) ? mode.function : "function…"}
                mono={isFunctionMode(mode)}
                hint="a function decides each call, and may ask you — smart, or your own"
                onPress={() => setNaming(true)}
              />
            </>
          )}
        </SubMenu>
      ) : null}
    </RNView>
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

/** One tool, as a line of a permission set on the page: its minus, its words, its implementation and mode. */
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
}: {
  tool: ToolChoice;
  spec?: ToolSpec | undefined;
  mode: PermissionSetMode;
  impl: ToolImplementation;
  onMode: (next: PermissionSetMode) => void;
  onImpl: (next: ToolImplementation) => void;
  note?: string | undefined;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
}): JSX.Element {
  const names = Object.entries(tool.natives ?? {});
  const native = names.length > 0 ? "native" : undefined;
  const nativeHint = names.length > 0 ? `the agent's own — ${names.map(([route, name]) => `${name} on ${route}`).join(", ")}` : undefined;
  const hint = note ?? (tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name));
  return (
    <Line>
      {onRemove !== undefined ? <RemoveLine subject={spec?.label ?? tool.name} onRemove={onRemove} /> : null}
      <Grant icon={(TOOL_ICONS[tool.name] ?? "tool") as IconName} name={spec?.label ?? tool.name} hint={hint} title={hint} />
      {native !== undefined ? <ImplPicker value={impl} native={native} nativeHint={nativeHint} onPick={onImpl} readOnly={readOnly} /> : null}
      <ModePicker mode={mode} title={`${tool.name}: ${modeMeta(mode).hint}`} onMode={onMode} readOnly={readOnly} />
    </Line>
  );
}

/** A line of Execution that is not a tool: a command the permission set names, or `script`. */
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
}: {
  subject: string;
  hint?: string;
  mode: PermissionSetMode;
  onMode: (next: PermissionSetMode) => void;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  /** A runner with no line of its own: 23 in, its mode faded. */
  follows?: boolean;
  mono?: boolean;
  icon?: IconName;
}): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  return (
    <Line {...(follows && readOnly !== true ? { pad: 23 } : {})}>
      {onRemove !== undefined ? <RemoveLine subject={subject} onRemove={onRemove} /> : null}
      <Grant icon={icon ?? (script ? "script" : "terminal")} name={subject} hint={hint ?? ""} mono={mono ?? !script} title={hint ?? subject} />
      <ModePicker mode={mode} title={`${subject}: ${modeMeta(mode).hint}`} onMode={onMode} readOnly={readOnly} faded={follows} />
    </Line>
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
export function AddMenu({ label, options, onPick, typed }: { label: string; options: readonly AddOption[]; onPick: (subject: string) => void; typed?: { label: string; example: string; onAdd: (typed: string) => string | undefined } | undefined }): JSX.Element | null {
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
              icon="terminal"
              name="another…"
              hint={`type one, like ${typed.example}`}
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
}: {
  permissionSet: PermissionSet;
  open: boolean;
  onOpen: () => void;
  onGroupMode: (next: PermissionSetMode) => void;
  onRunnerMode: (program: string, next: PermissionSetMode) => void;
  onRemoveRunner: (program: string) => void;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
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
              mode={row.own ?? fallback}
              readOnly={readOnly}
              follows={row.own === undefined}
              onRemove={row.own !== undefined && readOnly !== true ? () => onRemoveRunner(row.program) : undefined}
              onMode={(next) => onRunnerMode(row.program, next)}
            />
          ))}
        </FoldBody>
      ) : null}
    </View>
  );
}

/** One PROGRAM under Execution: a fold over the subcommands the permission set names. */
export function CommandGroupRow({
  group,
  permissionSet,
  open,
  onOpen,
  onMode,
  children,
  onRemove,
  readOnly,
}: {
  group: CommandGroup;
  permissionSet: PermissionSet;
  open: boolean;
  onOpen: () => void;
  onMode: (next: PermissionSetMode) => void;
  children: ReactNode;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
}): JSX.Element {
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
          {...(group.subs.length > 0 ? { count: group.subs.length } : {})}
        />
        <ModePicker head mode={groupModeOf(permissionSet, group)} title={`${group.program}: any ${group.program} command not named under it`} onMode={onMode} readOnly={readOnly} />
      </View>
      {open ? <FoldBody sub>{children}</FoldBody> : null}
    </View>
  );
}

export { SCRIPT_HINT, RUNNERS_HINT, SHELL_HINT, TOOL_ICONS };
