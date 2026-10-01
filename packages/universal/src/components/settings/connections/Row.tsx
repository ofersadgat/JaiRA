import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Animated, Easing } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { stateWord, type ProviderState } from "@jaira/ui/connectionsModel";
import { Press, Txt, edge, lengthToken, useHover, type FontSpec } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { isStill } from "../../../motion";
import { Icon } from "../../panel/Icon";
import { BrandIcon } from "../bits";
import { Button } from "../Button";
import { Switch } from "../controls";
import { useDrawnRow } from "../SettingsPage";

/**
 * One Connections row and the boxes it is made of: the provider, forge and MCP server rows
 * (`ProviderRows.tsx`, `ForgeRows.tsx`, `McpServerRows.tsx`) are all built of these. How it looks:
 *
 *   the rows              column, 2 between rows; in a card each row padding 13 16, a --line above
 *                         all but the first
 *   a row                 radius --control-radius; hovered --fill-ghost-hover. Off: the title and
 *                         the brand mark at .55
 *   its line              what it is (growing) | its boxes | its switch and chevron, top-aligned,
 *                         14 apart; what is wide goes across under them, 8 below
 *   what it is            column, gap 3
 *   its head              row, centred, gap 8; the title app 600 at 13/12.5, growing, cut with …
 *                         (mono: the data face at that size)
 *   its sentence          30 in, app 11.5/12.5, line 1.45, --dim; its state --text (--bad not working,
 *                         --warn not signed in); the fix a line of its own, app 11/12.5, line 1.4,
 *                         --accent, 2 above
 *   the version           data 10.5/12 --dim, 30 in
 *   the boxes             row, wraps, to the right, gap 8; each box 200 wide. With none they are not
 *                         there, and the controls stand 14 in from the row's right
 *   the controls          row, centred, gap 6, 1 down, at least 52 wide, to the right
 *   the chevron           a quiet button, padding 2, the chevron 14 (turned over when open)
 *   a login's card        column, gap 2, padding 8 10 9, 1px --line, radius --card-radius, --panel;
 *                         active ringed --accent twice (border and inset); refused --tint-warn,
 *                         --warn 45% into --line
 *   its top               row, centred, gap 8; the mark 24 round, --panel-3, app 600 11px --dim
 *   who                   data 11.5/12 --text, one line, cut with …
 *   a tag                 app 10.5/12.5 on a 1.6 line, padding 0 7, round; accent --accent on
 *                         --tint-accent, warn --warn on --tint-warn, ok, bad
 *   log out               a ghost button, 24 square, no padding, the logout icon 14 in --dim, 2 out
 *                         at the top and right
 *   a card's actions      row, wraps, centred, gap 6, pushed to the bottom, 4 above; its buttons
 *                         padding 1 8 at app 11/12.5
 *   a + box               column, centred, gap 2, at least 82 tall, padding 8, 1.5px dashed --rule,
 *                         radius --card-radius, --dim; a button's hovered --accent on --tint-accent; on a
 *                         row not signed in --warn 55% into --rule; waiting a solid --line
 *   its +                 app 17/12.5 on a line of 1, --accent; the title app 600 11.5/12.5 --text;
 *                         the sub app 10.5/12.5 line 1.3 (a link: underlined in --rule, 2 under)
 *   a key's box           column, 1px --line, radius --card-radius, --panel (the card's padding and
 *                         gap); missing dashed, --bad 40% into --line, on --tint-bad. Its mark 24,
 *                         radius 6, 4 below, the lock 13; its facts a column, app 11/12.5 --dim
 *   a value's entry       column, gap 6, at most 420, padding 9, 1px --line, radius 8, --panel-2, 30 in
 *   the spinner           12 round, 2px --line, its top --accent, turning every 0.9 s
 */

type Tone = "accent" | "warn" | "ok" | "bad";

/** The rows of one card — a column, 2 between rows, a --line above all but the first. */
export function ConnRows({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" gap={2}>
      {children}
    </View>
  );
}

/** One row: what it is, its boxes and its controls on a line, then what goes across under them. */
export function ConnRow({
  first,
  state,
  main,
  boxes,
  controls,
  wide,
}: {
  first: boolean;
  state: ProviderState;
  main: ReactNode;
  /** The boxes, or nothing — with none their box is not drawn, and the controls take its place. */
  boxes: ReactNode[];
  controls: ReactNode;
  wide?: ReactNode[];
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  useDrawnRow(true);
  const shown = boxes.filter((b) => b !== null && b !== undefined && b !== false);
  const under = (wide ?? []).filter((b) => b !== null && b !== undefined && b !== false);
  return (
    <View
      flexDirection="column"
      gap={8}
      paddingVertical={13}
      paddingHorizontal={16}
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(first ? {} : (edge(t, { top: 1 }) as object))}
      backgroundColor={hovered ? (t.v("fill-ghost-hover") as never) : "transparent"}
      {...({ "data-state": state } as object)}
      {...hover}
    >
      <View flexDirection="row" alignItems="flex-start" gap={14}>
        <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} flexDirection="column" gap={3}>
          {main}
        </View>
        {shown.length > 0 ? (
          <View flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={8} flexShrink={1} minWidth={0}>
            {shown}
          </View>
        ) : null}
        <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={6} paddingTop={1} minWidth={52} flexShrink={0} {...(shown.length === 0 ? { marginRight: 14 } : {})}>
          {controls}
        </View>
      </View>
      {under}
    </View>
  );
}

/** Across the row, under its line — as an opened row's body (a column, gap 12, 30 in) when `body`. */
export function Wide({ body = false, children }: { body?: boolean; children: ReactNode }): JSX.Element {
  return body ? (
    <View flexDirection="column" gap={12} paddingLeft={30} minWidth={0}>
      {children}
    </View>
  ) : (
    <View minWidth={0}>{children}</View>
  );
}

/** The row's head: the mark with its state's dot on the corner, and the row's name. */
export function RowHead({ brand, state, title, mono = false }: { brand: string; state: ProviderState; title: string; mono?: boolean }): JSX.Element {
  const t = useTokens();
  const off = state === "off";
  const dot = state === "available" ? "ok" : state === "unavailable" ? "bad" : state === "needs-sign-in" || state === "unconfigured" ? "warn" : "dim";
  const size = t.scaled("size-app", 13 / 12.5);
  return (
    <View flexDirection="row" alignItems="center" gap={8}>
      <View position="relative" width={20} height={20} flexShrink={0} alignItems="center" justifyContent="center" {...({ title: stateWord(state) } as object)}>
        <View {...(off ? { opacity: 0.55 } : {})}>
          <BrandIcon name={brand} size={17} />
        </View>
        <View position="absolute" left={-2} top={-2} width={8} height={8} borderRadius={999} backgroundColor={t.v(dot) as never} {...({ boxShadow: `0 0 0 2px ${String(t.v("bg"))}` } as object)} />
      </View>
      <Txt
        spec={mono ? { voice: "data", scale: 13 / 12, weight: 600 } : { voice: "app", scale: 13 / 12.5, weight: 600 }}
        {...(mono && typeof size === "number" ? { fontSize: size, lineHeight: size * 1.5 } : {})}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        numberOfLines={1}
        {...(off ? { opacity: 0.55 } : {})}
      >
        {title}
      </Txt>
    </View>
  );
}

const SAY = { voice: "app", scale: 11.5 / 12.5, lineHeight: 1.45, color: "dim" } as const;

/**
 * On web, the line height written as a factor (unitless): Blink multiplies it out and snaps it to 1/64,
 * where a line given in px drifts a row down by hundredths — and words that break anywhere.
 */
function web(line: string): Record<string, unknown> {
  return isWeb ? { lineHeight: line, style: { overflowWrap: "anywhere" } } : {};
}

/** The row's state in one sentence, and what would fix it on a line of its own. */
export function Say({ state, word, detail, fix }: { state: ProviderState; word: string; detail?: string | undefined; fix?: string | undefined }): JSX.Element {
  return (
    <View flexDirection="column" paddingLeft={30}>
      <Txt spec={SAY} {...(web("1.45") as object)}>
        <Txt spec={{ ...SAY, color: state === "unavailable" ? "bad" : state === "needs-sign-in" ? "warn" : "text" }}>{word}</Txt>
        {/* " — " and the detail are two text nodes: Blink shapes each apart, as the reference pictures hold them. */}
        {detail !== undefined ? " — " : null}
        {detail !== undefined ? detail : null}
      </Txt>
      {fix !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "accent" }} marginTop={2} {...(web("1.4") as object)}>
          {"→ "}
          {fix}
        </Txt>
      ) : null}
    </View>
  );
}

/** The build, under the sentence. */
export function Version({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} marginLeft={30} alignSelf="flex-start">
      {children}
    </Txt>
  );
}

/** The switch and the chevron at the row's right edge. */
export function RowControls({ on, label, disabled, onToggle, open, title, onOpen }: { on: boolean; label: string; disabled: boolean; onToggle: (next: boolean) => void; open: boolean; title: string; onOpen: () => void }): JSX.Element {
  return (
    <>
      <Switch on={on} label={label} disabled={disabled} onChange={onToggle} />
      <Chevron open={open} label={open ? `hide ${title}'s settings` : `configure ${title}`} onPress={onOpen} />
    </>
  );
}

/** The chevron, a quiet button: configure, and Done when open. */
export function Chevron({ open, label, onPress }: { open: boolean; label: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      label={label}
      title={open ? "Done" : "Configure"}
      {...({ "aria-expanded": open } as object)}
      flexShrink={0}
      padding={2}
      borderWidth={1}
      borderStyle="solid"
      borderColor="transparent"
      borderRadius={lengthToken(t, "control-radius", 7)}
      alignItems="center"
      justifyContent="center"
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <View transform={[{ rotate: open ? "180deg" : "0deg" }]}>
          <Icon name="chevron" size={14} color={String(t.v(hovered ? "text" : "dim"))} />
        </View>
      )}
    </Press>
  );
}

/** A box's outside: 200 wide. */
function BoxSlot({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View width={200} flexDirection="row" alignSelf="stretch">
      {children}
    </View>
  );
}

/** A small round tag: its tone's colour on its tint. */
export function Tag({ tone, children }: { tone: Tone; children: string }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.6, color: tone }} paddingHorizontal={7} borderRadius={999} backgroundColor={t.v(`tint-${tone}`) as never} numberOfLines={1} flexShrink={0}>
      {children}
    </Txt>
  );
}

/** A login's card, for an agent's or a forge's. */
export function LoginCardBox({ active = false, refused = false, children }: { active?: boolean; refused?: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <BoxSlot>
      <View
        flexGrow={1}
        flexShrink={1}
        flexBasis="auto"
        minWidth={0}
        flexDirection="column"
        gap={2}
        paddingTop={8}
        paddingHorizontal={10}
        paddingBottom={9}
        borderRadius={lengthToken(t, "card-radius", 10)}
        backgroundColor={t.v(refused ? "tint-warn" : "panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, active ? "accent" : refused ? t.mix(t.v("warn"), 45, t.v("line")) : "line") as object)}
        {...(active ? ({ boxShadow: `inset 0 0 0 1px ${String(t.v("accent"))}` } as object) : {})}
      >
        {children}
      </View>
    </BoxSlot>
  );
}

/** A card's mark: an initial in a round (or, for a key, the lock in a rounded square). */
export function LoginMark({ initial, lock = false }: { initial?: string; lock?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View width={24} height={24} flexShrink={0} borderRadius={lock ? 6 : 999} alignItems="center" justifyContent="center" backgroundColor={t.v("panel-3") as never} {...(lock ? { marginBottom: 4 } : {})}>
      {lock ? (
        <Icon name="lock" size={13} color={String(t.v("dim"))} />
      ) : (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "dim", lineHeight: { px: 16.5 } }} fontSize={11} textAlign="center">
          {initial}
        </Txt>
      )}
    </View>
  );
}

/** Who, in the data face, on one line. */
export function Who({ children, grow = false }: { children: string; grow?: boolean }): JSX.Element {
  return (
    <Txt spec={{ voice: "data", scale: 11.5 / 12 }} numberOfLines={1} {...({ title: children } as object)} {...(grow ? { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 } : { minWidth: 0 })}>
      {children}
    </Txt>
  );
}

/** A card's facts: a column of small dim lines. */
export function Facts({ lines }: { lines: string[] }): JSX.Element | null {
  return (
    <View flexDirection="column">
      {lines.map((line, i) => (
        <Txt key={i} spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>
          {line}
        </Txt>
      ))}
    </View>
  );
}

/** Log out, as a 24-square ghost button with the icon. */
export function LogoutButton({ title, disabled, onPress }: { title: string; disabled: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      title={title}
      label="Log out"
      width={24}
      height={24}
      flexShrink={0}
      marginTop={-2}
      marginRight={-2}
      alignItems="center"
      justifyContent="center"
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(hovered && !disabled ? "rule" : "line") })}
    >
      <Icon name="logout" size={14} color={String(t.v("dim"))} />
    </Press>
  );
}

/** A card's actions: pushed to the card's bottom, 4 above. */
export function CardActions({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} marginTop="auto" paddingTop={4}>
      {children}
    </View>
  );
}

/** A button in a card or a + box: padding 1 8, app 11/12.5. */
export function SmallButton({
  kind = "plain",
  disabled,
  onPress,
  font = { scale: 11 / 12.5 },
  title,
  children,
}: {
  kind?: "plain" | "ghost" | "primary";
  disabled?: boolean;
  onPress: () => void;
  /** The text's font: app 11/12.5, or that of the box it stands in. */
  font?: Partial<FontSpec>;
  title?: string;
  children: string;
}): JSX.Element {
  return (
    <Button kind={kind} disabled={disabled} onPress={onPress} paddingVertical={1} paddingHorizontal={8} font={font} {...(title !== undefined ? { title } : {})}>
      {children}
    </Button>
  );
}

/** The spinner: a turning ring. */
export function Spin(): JSX.Element {
  const t = useTokens();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Held by a phone's test (`motion.ts`); never on web.
    if (isStill()) return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={{
        width: 12,
        height: 12,
        borderRadius: 999,
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: String(t.v("line")),
        borderTopColor: String(t.v("accent")),
        transform: [{ rotate }],
      }}
    />
  );
}

const PLUS_TITLE = { voice: "app", scale: 11.5 / 12.5, weight: 600 } as const;
const PLUS_SUB = { voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "dim" } as const;

/** The + of an add box. */
function Plus(): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 17 / 12.5, lineHeight: 1, color: "accent" }} textAlign="center">
      +
    </Txt>
  );
}

/** The ground of an add box: dashed --rule (a row not signed in: --warn into it; waiting: solid --line). */
function addEdge(t: ReturnType<typeof useTokens>, mode: "plain" | "warn" | "waiting", hovered: boolean): Record<string, unknown> {
  if (mode === "waiting") return edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, "line");
  return edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, hovered ? "accent" : mode === "warn" ? t.mix(t.v("warn"), 55, t.v("rule")) : "rule", "dashed");
}

const ADD_BOX = { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, minHeight: 82, padding: 8 } as const;

/**
 * The words of a + box that is a button do not wrap, and the button is as wide as they are at least
 * (`min-width: auto` on web): a long sub runs it past its 200.
 */
const NOWRAP: Record<string, unknown> = isWeb ? { whiteSpace: "nowrap" } : { numberOfLines: 1 };

/** One + box that is one button — "Add a key", "Add a host", "Store a secret". */
export function AddBox({ title, sub, disabled = false, warn = false, onPress }: { title: string; sub?: string | undefined; disabled?: boolean; warn?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <BoxSlot>
      <Press
        onPress={onPress}
        disabled={disabled}
        {...ADD_BOX}
        {...(isWeb ? { minWidth: "auto" } : {})}
        borderRadius={lengthToken(t, "card-radius", 10)}
        {...(disabled ? { opacity: 0.5 } : {})}
        box={({ hovered }) => ({ ...ADD_BOX, ...addEdge(t, warn ? "warn" : "plain", hovered && !disabled), borderRadius: lengthToken(t, "card-radius", 10), backgroundColor: hovered && !disabled ? t.v("tint-accent") : "transparent" })}
      >
        <Plus />
        <Txt spec={{ ...PLUS_TITLE }} textAlign="center" {...NOWRAP}>
          {title}
        </Txt>
        {sub !== undefined ? (
          <Txt spec={PLUS_SUB} textAlign="center" {...(web("1.3") as object)} {...NOWRAP}>
            {sub}
          </Txt>
        ) : null}
      </Press>
    </BoxSlot>
  );
}

/**
 * A + box with two ways in — its own button (sign in) and a link under it (a key, a token) — or, with
 * no `main`, only the + and the link.
 */
export function SplitAddBox({
  main,
  link,
  sub,
  disabled = false,
  warn = false,
}: {
  main?: { title: string; onPress: () => void } | undefined;
  link?: { text: string; onPress: () => void } | undefined;
  /** Plain words under the button, where there is no link. */
  sub?: string | undefined;
  disabled?: boolean;
  warn?: boolean;
}): JSX.Element {
  const t = useTokens();
  return (
    <BoxSlot>
      <View {...ADD_BOX} borderRadius={lengthToken(t, "card-radius", 10)} {...(addEdge(t, warn ? "warn" : "plain", false) as object)}>
        {main !== undefined ? (
          // Its box not grown on a phone (`fill`): in a box stretched to its neighbour, Yoga fed the growth
          // back into the row's height. The pressable is only ever its content's size, as it is on web.
          <Press onPress={main.onPress} disabled={disabled} fill={isWeb} flexDirection="column" alignItems="center" gap={2} {...(disabled ? { opacity: 0.5 } : {})}>
            {({ hovered }) => (
              <>
                <Plus />
                <Txt spec={{ ...PLUS_TITLE, color: hovered && !disabled ? "accent" : "text" }} textAlign="center" {...NOWRAP}>
                  {main.title}
                </Txt>
              </>
            )}
          </Press>
        ) : (
          <Plus />
        )}
        {link !== undefined ? (
          <Press onPress={link.onPress} disabled={disabled} fill={isWeb} {...(disabled ? { opacity: 0.5 } : {})}>
            <Txt spec={PLUS_SUB} textAlign="center" textDecorationLine="underline" {...((isWeb ? { lineHeight: "1.3", style: { textDecorationColor: String(t.v("rule")), textUnderlineOffset: 2 } } : { textDecorationColor: String(t.v("rule")) }) as object)} {...NOWRAP}>
              {link.text}
            </Txt>
          </Press>
        ) : sub !== undefined ? (
          <Txt spec={PLUS_SUB} textAlign="center" {...(web("1.3") as object)}>
            {sub}
          </Txt>
        ) : null}
      </View>
    </BoxSlot>
  );
}

/** A + box while a sign-in waits on the browser — the spinner, what to do, Cancel. */
export function WaitingBox({ title, sub, onCancel }: { title: string; sub?: ReactNode; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <BoxSlot>
      <View {...ADD_BOX} borderRadius={lengthToken(t, "card-radius", 10)} {...(addEdge(t, "waiting", false) as object)} role="status">
        <Spin />
        <Txt spec={PLUS_TITLE} textAlign="center">
          {title}
        </Txt>
        {sub !== undefined ? (
          <Txt spec={PLUS_SUB} textAlign="center" {...(web("1.3") as object)}>
            {sub}
          </Txt>
        ) : null}
        <SmallButton kind="ghost" onPress={onCancel}>
          Cancel
        </SmallButton>
      </View>
    </BoxSlot>
  );
}

/** A key, token or secret by its name, where it was found, and what it spent. */
export function KeyBox({ name, facts, missing = false, children }: { name: string; facts: string[]; missing?: boolean; children?: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <BoxSlot>
      <View
        flexGrow={1}
        flexShrink={1}
        flexBasis="auto"
        minWidth={0}
        flexDirection="column"
        gap={2}
        paddingTop={8}
        paddingHorizontal={10}
        paddingBottom={9}
        borderRadius={lengthToken(t, "card-radius", 10)}
        backgroundColor={t.v(missing ? "tint-bad" : "panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, missing ? t.mix(t.v("bad"), 40, t.v("line")) : "line", missing ? "dashed" : "solid") as object)}
      >
        <LoginMark lock />
        <Who>{name}</Who>
        <Facts lines={facts} />
        {children}
      </View>
    </BoxSlot>
  );
}

/** 30 in under the row: where a value is typed, and the store it goes to. */
export function EntryBox({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View
      marginLeft={30}
      flexDirection="column"
      gap={6}
      maxWidth={420}
      padding={9}
      borderRadius={8}
      backgroundColor={t.v("panel-2") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
    >
      {children}
    </View>
  );
}

/** A row's own problem: app 11/12.5 in --warn. */
export function Problem({ children, indent = false }: { children: string; indent?: boolean }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} {...(indent ? { paddingLeft: 0 } : {})}>
      {children}
    </Txt>
  );
}

/** Hold a state that a row's parent resets — the open form's, the chevron's. */
export function useToggle(start = false): [boolean, (v?: boolean) => void] {
  const [on, set] = useState(start);
  return [on, (v) => set((was) => (v === undefined ? !was : v))];
}
