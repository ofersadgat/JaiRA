import { useState, type JSX, type ReactNode } from "react";
import { TextInput as RNTextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { Press, Txt, edge, font, lengthToken, placeholderColor } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Svg } from "../panel/Svg";

/**
 * The form's controls, universal (decision 0015): `controls.tsx`'s `TextInput`, `NumInput`,
 * `NumberText`, `TextArea` and `Chip`, the schema form's checkbox (`.sf-bool`) and its shape chips
 * (`.sf-pick`). The rules they carry, from `styles.css` (`cascade.mts` on Settings → Runs and Data):
 *
 *   .cfg-input           width 100%, min 0; the body's font (line 1.5) at app 12.5/12.5, --text on --bg,
 *                        1px --line (hovered --rule, focused --accent), radius --control-radius,
 *                        padding 6 9. Disabled: 0.55 opacity, --dim on --panel-2.
 *   .cfg-input.mono      data 12/12
 *   .cfg-input.num       at most 120 wide
 *   textarea.cfg-input   line 1.45, `rows` lines tall
 *   .cfg-field.bad       the box ringed --bad
 *   .cfg-chip            a `button` (inline-flex, centred, the body's line 1.5): padding 3 11, radius
 *                        --control-radius-sm, 1px transparent, app 600 at 11.5/12.5 in --dim; hovered
 *                        --fill-ghost-hover and --text; on: --fill-accent ground and ring, --on-accent,
 *                        --sheen
 *   .sf-pick             inline-flex, wraps, gap 1, padding 1, 1px --line, radius --control-radius, --bg;
 *                        its chips padding 0 8, app 10.5/12.5 on an 18px line, radius 5
 *   .sf-bool             row, centred, gap 6: Chromium's own checkbox (13 square, margin 3 3 3 4) and
 *                        `.sub` (app 11/12.5, --dim) saying yes or no
 */

/** `:focus-visible` on a box: `.cfg-input:focus-visible` (--accent) and the page's ring (2px --focus-ring, 1 out). */
function focusRing(t: ReturnType<typeof useTokens>, focused: boolean): Record<string, unknown> {
  return focused && isWeb ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: t.v("focus-ring"), outlineOffset: 1 } : { outlineWidth: 0 };
}

/**
 * `.cfg-input`: a text box that takes its column's width (`controls.tsx`'s `TextInput`). `suggest` is the
 * `<datalist>` a choice box offers; on the desktop it drops down only while typing, so it draws nothing
 * here until it does.
 */
export function FormInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  mono = false,
  num = false,
  label,
  bad = false,
  width,
  onBlur,
  onSubmit,
  onEscape,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  mono?: boolean;
  /** `.num`: at most 120 wide. */
  num?: boolean;
  label?: string | undefined;
  /** `.cfg-field.bad`: the value has a complaint. */
  bad?: boolean;
  width?: number | string | undefined;
  onBlur?: (() => void) | undefined;
  onSubmit?: (() => void) | undefined;
  onEscape?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const spec = mono ? ({ voice: "data", scale: 1 } as const) : ({ voice: "app", scale: 1 } as const);
  const ring = bad ? "bad" : focused ? "accent" : hovered && !disabled ? "rule" : "line";
  return (
    <RNTextInput
      value={value}
      onChangeText={onChange}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor(look.scheme) } : {})}
      editable={!disabled}
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      inputMode={num ? "decimal" : "text"}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      {...(onSubmit !== undefined ? { onSubmitEditing: onSubmit } : {})}
      {...((onEscape !== undefined ? { onKeyPress: (e: { nativeEvent: { key: string } }) => e.nativeEvent.key === "Escape" && onEscape() } : {}) as object)}
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)}
      style={
        {
          ...(font(t, { ...spec, color: disabled ? "dim" : "text" }) as object),
          width: width ?? "100%",
          minWidth: 0,
          ...(num ? { maxWidth: 120 } : {}),
          paddingVertical: 6,
          paddingHorizontal: 9,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(ring),
          borderRadius: lengthToken(t, "control-radius", 7),
          backgroundColor: t.v(disabled ? "panel-2" : "bg"),
          ...(disabled ? { opacity: 0.55 } : {}),
          ...focusRing(t, focused),
        } as never
      }
    />
  );
}

/**
 * `NumInput`: a number box reporting `number | undefined` — empty means unset, and inherits. It holds
 * what was typed until the box is left, so `0.` survives long enough to become `0.5`.
 */
export function NumInput({
  value,
  onChange,
  placeholder = "—",
  disabled,
  mono = false,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  placeholder?: string;
  disabled?: boolean | undefined;
  mono?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <FormInput
      value={draft ?? (value === undefined ? "" : String(value))}
      num
      mono={mono}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(text) => {
        setDraft(text);
        const n = Number(text);
        onChange(text.trim() === "" || !Number.isFinite(n) ? undefined : n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** `NumberText`: a number box that keeps what was TYPED, for a form that says what is wrong with it. */
export function NumberText({ value, onChange, disabled, bad }: { value: number | string | undefined; onChange: (text: string) => void; disabled?: boolean | undefined; bad?: boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <FormInput
      value={draft ?? (value === undefined ? "" : String(value))}
      mono
      num
      disabled={disabled}
      {...(bad !== undefined ? { bad } : {})}
      onChange={(text) => {
        setDraft(text);
        onChange(text);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** `textarea.cfg-input`: several lines — prose in the app's face, anything else in data voice. */
export function TextArea({
  value,
  onChange,
  placeholder,
  disabled = false,
  rows = 3,
  mono = true,
  bad = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  rows?: number;
  mono?: boolean;
  bad?: boolean;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const spec = mono ? ({ voice: "data", scale: 1, lineHeight: 1.45 } as const) : ({ voice: "app", scale: 1, lineHeight: 1.45 } as const);
  const size = t.scaled(`size-${spec.voice}`, 1);
  const line = typeof size === "number" ? size * 1.45 : 18;
  const ring = bad ? "bad" : focused ? "accent" : hovered && !disabled ? "rule" : "line";
  return (
    <RNTextInput
      value={value}
      onChangeText={onChange}
      multiline
      numberOfLines={rows}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor(look.scheme) } : {})}
      editable={!disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), rows } as object)}
      style={
        {
          ...(font(t, { ...spec, color: disabled ? "dim" : "text" }) as object),
          width: "100%",
          minWidth: 0,
          // A textarea's own height: its rows of lines, the padding and the ring.
          height: rows * line + 12 + 2,
          paddingVertical: 6,
          paddingHorizontal: 9,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(ring),
          borderRadius: lengthToken(t, "control-radius", 7),
          backgroundColor: t.v(disabled ? "panel-2" : "bg"),
          textAlignVertical: "top",
          ...(isWeb ? { resize: "vertical" } : {}),
          ...(disabled ? { opacity: 0.55 } : {}),
          ...focusRing(t, focused),
        } as never
      }
    />
  );
}

/**
 * Chromium's own checkbox, as it draws `<input type="checkbox">` (the stylesheet leaves its look to the
 * browser): 13 square with a 3 3 3 4 margin, a 1px ring rounded 2. Light: white inside #767676
 * (hovered #4f4f4f); checked, #0075ff (hovered #005cc8) with a white tick. Dark (the page's
 * `color-scheme`): #3b3b3b inside #858585 (hovered #9c9c9c); checked #99c8ff (hovered #d1e6ff) with a
 * #3b3b3b tick. Measured off the desktop's pictures.
 */
export function Checkbox({ checked, disabled = false, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label?: string }): JSX.Element {
  const look = useLook();
  const dark = look.scheme === "dark";
  return (
    <Press
      onPress={() => onChange(!checked)}
      disabled={disabled}
      {...(label !== undefined ? { label } : {})}
      {...({ role: "checkbox", "aria-checked": checked } as object)}
      width={13}
      height={13}
      marginTop={3}
      marginRight={3}
      marginBottom={3}
      marginLeft={4}
      flexShrink={0}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => {
        const hover = hovered && !disabled;
        const fill = checked ? (dark ? (hover ? "#d1e6ff" : "#99c8ff") : hover ? "#005cc8" : "#0075ff") : dark ? "#3b3b3b" : "#ffffff";
        const ring = checked ? fill : dark ? (hover ? "#9c9c9c" : "#858585") : hover ? "#4f4f4f" : "#767676";
        return { width: 13, height: 13, borderRadius: 2, borderWidth: checked ? 0 : 1, borderStyle: "solid", borderColor: ring, backgroundColor: fill };
      }}
    >
      {checked ? (
        <Svg
          width={13}
          height={13}
          viewBox="0 0 13 13"
          color={dark ? "#3b3b3b" : "#ffffff"}
          strokeWidth={1.9}
          linecap="butt"
          linejoin="miter"
          shapes={[{ kind: "path", d: "M2.6 6.5 L5.2 9.1 L10.4 3.9" }]}
        />
      ) : null}
    </Press>
  );
}

/** `.sf-bool`: a checkbox and the word it stands for. */
export function BoolField({ value, disabled = false, onChange }: { value: boolean; disabled?: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={6}>
      <Checkbox checked={value} disabled={disabled} onChange={onChange} />
      <Press onPress={() => !disabled && onChange(!value)} disabled={disabled}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{value ? "yes" : "no"}</Txt>
      </Press>
    </View>
  );
}

/** `.cfg-chip`: a pill that is also a choice. `small` is the one inside `.sf-pick`. */
export function Chip({
  active,
  onPress,
  disabled = false,
  title,
  small = false,
  children,
}: {
  active: boolean;
  onPress: () => void;
  disabled?: boolean | undefined;
  title?: string | undefined;
  small?: boolean;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      {...(title !== undefined ? { title } : {})}
      {...({ "aria-pressed": active } as object)}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={5}
      paddingVertical={small ? 0 : 3}
      paddingHorizontal={small ? 8 : 11}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={small ? 5 : lengthToken(t, "control-radius-sm", 5)}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) =>
        active
          ? { backgroundColor: t.v("fill-accent"), borderColor: t.v("fill-accent"), ...(disabled ? {} : { boxShadow: t.v("sheen") }) }
          : { backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent", borderColor: "transparent" }
      }
    >
      {({ hovered }) => (
        <Txt
          spec={{ voice: "app", scale: (small ? 10.5 : 11.5) / 12.5, weight: 600, color: active ? "on-accent" : hovered && !disabled ? "text" : "dim", ...(small ? { lineHeight: { px: 18 } } : {}) }}
          numberOfLines={1}
        >
          {children}
        </Txt>
      )}
    </Press>
  );
}

/** `.sf-pick`: chips in a well of their own, so they read as ONE choice. */
export function PickWell({ label, children, self = false }: { label: string; children: ReactNode; self?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="row"
      flexWrap="wrap"
      gap={1}
      padding={1}
      borderRadius={lengthToken(t, "control-radius", 7)}
      backgroundColor={t.v("bg") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      {...(self ? { alignSelf: "flex-start" } : {})}
      role="group"
      aria-label={label}
    >
      {children}
    </View>
  );
}
