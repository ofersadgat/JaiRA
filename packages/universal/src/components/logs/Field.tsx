import type { JSX } from "react";
import { TextInput } from "react-native";
import { ENTER_KEEPS_FOCUS, font, lengthToken, placeholderColor, useHover, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";

/** The body's face (app at 13/12.5, line 1.5): what a plain field and a plain paragraph are written in. */
export const BODY: FontSpec = { voice: "app", scale: 13 / 12.5 };

/**
 * A plain text field: the body's font, --text on --bg, 1px --line (hovered --rule), radius
 * --control-radius, padding 5 9; its text on the body's line (1.5). The placeholder is Chromium's light
 * one (#757575) in every look: it draws that under a dark palette too (measured).
 */
export function BarInput({
  value,
  onChange,
  placeholder,
  label,
  width,
  spec = BODY,
  disabled = false,
  numeric = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  width?: number;
  spec?: FontSpec;
  disabled?: boolean;
  numeric?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <TextInput {...(ENTER_KEEPS_FOCUS as object)}
      value={value}
      onChangeText={onChange}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor("light") } : {})}
      editable={!disabled}
      {...(numeric ? { inputMode: "decimal" as const } : {})}
      {...(label !== undefined ? { accessibilityLabel: label } : {})}
      {...(hover as object)}
      style={
        {
          ...(font(t, { ...spec, color: disabled ? "dim" : "text" }) as object),
          ...(width !== undefined ? { width } : {}),
          flexShrink: 0,
          minWidth: 0,
          paddingVertical: 5,
          paddingHorizontal: 9,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(hovered && !disabled ? "rule" : "line"),
          borderRadius: lengthToken(t, "control-radius", 7),
          backgroundColor: t.v(disabled ? "panel-2" : "bg"),
        } as never
      }
    />
  );
}

