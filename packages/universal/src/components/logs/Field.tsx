import type { JSX } from "react";
import { TextInput } from "react-native";
import { font, lengthToken, placeholderColor, useHover, type FontSpec } from "../../primitives";
import { useLook, useTokens } from "../../tokens";

/** The body's face (app at 13/12.5, line 1.5): what an unclassed element on the desktop's page inherits. */
export const BODY: FontSpec = { voice: "app", scale: 13 / 12.5 };

/**
 * A plain `<input>` (`input` with no class): the body's font, --text on --bg, 1px --line (hovered --rule),
 * radius --control-radius, padding 5 9; its text on the inherited line (1.5).
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
  const look = useLook();
  const [hovered, hover] = useHover();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      {...(placeholder !== undefined ? { placeholder, placeholderTextColor: placeholderColor(look.scheme) } : {})}
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

