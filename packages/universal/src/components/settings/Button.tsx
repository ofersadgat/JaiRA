import type { JSX, ReactNode } from "react";
import { Press, Txt, lengthToken, padToken, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `styles.css`'s `button` and its variants, universal (decision 0015) — the settings pages' buttons
 * (the layer switch, Re-check, Add). The rules it carries:
 *
 *   button              --panel-2 ground, 1px --line ring, radius --control-radius (7), padding
 *                       --control-pad (3 10), row, centred, gap 5; the text the body's (app, 13/12.5,
 *                       line 1.5), --text, one line. Hovered: --panel-3 ground, --rule ring.
 *                       Disabled: half opacity, no shadow.
 *   button.ghost        transparent, no shadow; hovered --fill-ghost-hover (the ring still --rule)
 *   button.quiet        transparent, no ring, --dim; hovered --fill-ghost-hover and --text
 *   button.danger       transparent, --bad text, ring --bad 40% into --line; hovered --tint-bad and
 *                       --bad 60% into --line
 *   button.primary      --fill-accent ground and ring, --on-accent at 600, --sheen; hovered
 *   button.layer-on       --fill-accent-hover ground and ring
 */
export type ButtonKind = "plain" | "ghost" | "quiet" | "primary" | "danger";

export function Button({
  kind = "plain",
  onPress,
  disabled = false,
  title,
  label,
  font,
  children,
  ...rest
}: {
  kind?: ButtonKind;
  onPress?: () => void;
  disabled?: boolean | undefined;
  title?: string | undefined;
  label?: string | undefined;
  /** The text's font, where the button's parent sets another than the body's. */
  font?: Partial<FontSpec>;
  children: ReactNode;
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const [padV, padH] = padToken(t, "control-pad", [3, 10]);
  const filled = kind === "primary";
  return (
    <Press
      {...(onPress !== undefined ? { onPress } : {})}
      disabled={disabled}
      {...(title !== undefined ? { title } : {})}
      {...(label !== undefined ? { label } : {})}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={5}
      paddingVertical={padV}
      paddingHorizontal={padH}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => {
        const hover = hovered && !disabled;
        if (filled) {
          return {
            backgroundColor: t.v(hover ? "fill-accent-hover" : "fill-accent"),
            borderColor: t.v(hover ? "fill-accent-hover" : "fill-accent"),
            ...(disabled ? {} : { boxShadow: t.v("sheen") }),
          };
        }
        if (kind === "danger") return { backgroundColor: hover ? t.v("tint-bad") : "transparent", borderColor: t.mix(t.v("bad"), hover ? 60 : 40, t.v("line")) };
        if (kind === "quiet") return { backgroundColor: hover ? t.v("fill-ghost-hover") : "transparent", borderColor: "transparent" };
        if (kind === "ghost") return { backgroundColor: hover ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(hover ? "rule" : "line") };
        return { backgroundColor: t.v(hover ? "panel-3" : "panel-2"), borderColor: t.v(hover ? "rule" : "line") };
      }}
      {...rest}
    >
      {({ hovered }) =>
        typeof children === "string" ? (
          <Txt
            spec={{
              voice: "app",
              scale: 13 / 12.5,
              weight: filled ? 600 : 400,
              color: filled ? "on-accent" : kind === "danger" ? "bad" : kind === "quiet" && !(hovered && !disabled) ? "dim" : "text",
              ...font,
            }}
            numberOfLines={1}
          >
            {children}
          </Txt>
        ) : (
          children
        )
      }
    </Press>
  );
}
