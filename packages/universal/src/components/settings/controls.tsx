import type { JSX } from "react";
import { View } from "@tamagui/core";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * The settings controls, universal (decision 0015): `controls.tsx`'s `Switch` and `settingsLayout.tsx`'s
 * `Segmented`. The rules they carry, from `styles.css`:
 *
 *   .cfg-switch          30×18, round, 1px --line, --panel-2; hovered --rule and --panel-3. On:
 *                        --fill-accent ground and ring. Disabled: half opacity.
 *   .cfg-switch-knob     12 round, centred, 5 left of centre in --dim; on, 5 right in --on-accent
 *   .set-seg             row, gap 2, padding 2, 1px --line, radius 9, --panel-2
 *   .set-seg button      no ring, radius 7, padding 4 12, the body's text (app 13/12.5, line 1.5) at
 *                        500 in --dim; hovered --fill-ghost-hover and --text; chosen: --panel, --text,
 *                        ringed 1px --line with a 0 1 2 shadow at 6%. Disabled: half opacity.
 */

/** On or off, as a switch — `controls.tsx`'s `Switch`. */
export function Switch({ on, label, disabled = false, onChange }: { on: boolean; label: string; disabled?: boolean | undefined; onChange: (next: boolean) => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={() => onChange(!on)}
      disabled={disabled}
      label={label}
      title={label}
      {...({ role: "switch", "aria-checked": on } as object)}
      width={30}
      height={18}
      flexShrink={0}
      borderRadius={999}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => {
        const hover = hovered && !disabled;
        return {
          ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "fill-accent" : hover ? "rule" : "line"),
          borderRadius: 999,
          backgroundColor: t.v(on ? "fill-accent" : hover ? "panel-3" : "panel-2"),
          alignItems: "center",
          justifyContent: "center",
        };
      }}
    >
      <View width={12} height={12} borderRadius={999} backgroundColor={t.v(on ? "on-accent" : "dim") as never} transform={[{ translateX: on ? 5 : -5 }]} />
    </Press>
  );
}

/** Two to four choices side by side, the chosen one raised — `settingsLayout.tsx`'s `Segmented`. */
export function Segmented<T extends string>({
  value,
  options,
  label,
  disabled = false,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [label: string, value: T]>;
  label: string;
  disabled?: boolean | undefined;
  onChange: (value: T) => void;
}): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="row"
      alignSelf="flex-start"
      gap={2}
      padding={2}
      borderRadius={9}
      backgroundColor={t.v("panel-2") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      role="group"
      aria-label={label}
    >
      {options.map(([text, option]) => {
        const on = value === option;
        return (
          <Press
            key={option}
            onPress={() => onChange(option)}
            disabled={disabled}
            {...({ "aria-pressed": on } as object)}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            paddingVertical={4}
            paddingHorizontal={12}
            borderRadius={7}
            {...(disabled ? { opacity: 0.5 } : {})}
            box={({ hovered }) =>
              on
                ? { backgroundColor: t.v("panel"), boxShadow: `0 0 0 1px ${String(t.v("line"))}, 0 1px 2px rgba(0, 0, 0, 0.06)` }
                : { backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent" }
            }
          >
            {({ hovered }) => (
              <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 500, color: on || (hovered && !disabled) ? "text" : "dim" }} numberOfLines={1}>
                {text}
              </Txt>
            )}
          </Press>
        );
      })}
    </View>
  );
}
