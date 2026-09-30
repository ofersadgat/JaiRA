import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import { brandHex, brandMark, brandOf } from "@jaira/ui/brands";
import { Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Svg } from "../panel/Svg";

/**
 * Small pieces the settings pages share, universal (decision 0015) — each a `styles.css` rule or two:
 *
 *   .cfg-hint            app 11/12.5, line 1.4, --dim (a `p` in a card: padding 13 16)
 *   .cfg-stack           column, gap 10
 *   .cfg-status          inline row, centred, gap 5, app 10.5/12.5 --dim on --panel-2, radius
 *                        --control-radius-sm, padding 2 8 2 7, one line; `available` --ok on --tint-ok,
 *                        `unavailable` --bad on --tint-bad, `unconfigured` --warn on --tint-warn, `here`
 *                        --accent on --accent 12% into --panel
 *   .cfg-dot             6 round, the text's colour (--accent in `here`)
 *   .cfg-mark            20 square, centred; its mark 17 square; the dot 8 round at -2 -2, --dim (ok,
 *                        bad, warn by state), ringed 2px --bg
 *   .cx-src              app 500 at 9.5/12.5 on a 1.5 line, --tok-hint on --panel-2, round, padding 0 5,
 *                        6 after what it follows
 *   .pane-actions        row, centred, gap 6, wraps
 *   code                 data 11/12
 */

const HINT = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const;

/** `.cfg-hint`, as a line of its own. `card` is one straight in a card (`.set-group > .cfg-hint`: padding 13 16). */
export function Hint({ children, card = false, color, ...rest }: { children: ReactNode; card?: boolean; color?: string } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ ...HINT, ...(color !== undefined ? { color } : {}) }} {...(card ? { paddingVertical: 13, paddingHorizontal: 16 } : {})} {...rest}>
      {children}
    </Txt>
  );
}

/** `code`: data 11/12 — inside a hint, at the hint's line. */
export function Code({ children, ...rest }: { children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" }} {...rest}>
      {children}
    </Txt>
  );
}

/** `.cfg-stack`. `card` is one straight in a card (padding 13 16). */
export function Stack({ children, card = false, gap = 10 }: { children: ReactNode; card?: boolean; gap?: number }): JSX.Element {
  return (
    <View flexDirection="column" gap={gap} {...(card ? { paddingVertical: 13, paddingHorizontal: 16 } : {})}>
      {children}
    </View>
  );
}

/** `.pane-actions`. */
export function PaneActions({ children, ...rest }: { children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap" {...rest}>
      {children}
    </View>
  );
}

export type StatusKind = "plain" | "available" | "unavailable" | "unconfigured" | "unchecked" | "here";

/** `.cfg-status`: a state in one word and one colour, with its dot. */
export function Status({
  kind = "plain",
  dot = true,
  title,
  inline = false,
  weight,
  children,
}: {
  kind?: StatusKind;
  dot?: boolean;
  title?: string | undefined;
  inline?: boolean;
  /** The weight it inherits where it stands (a detail's title: 600). */
  weight?: number;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const ink = kind === "available" ? "ok" : kind === "unavailable" ? "bad" : kind === "unconfigured" ? "warn" : kind === "here" ? "accent" : "dim";
  const ground =
    kind === "available" ? t.v("tint-ok") : kind === "unavailable" ? t.v("tint-bad") : kind === "unconfigured" ? t.v("tint-warn") : kind === "here" ? t.mix(t.v("accent"), 12, t.v("panel")) : t.v("panel-2");
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={5}
      flexShrink={0}
      alignSelf="center"
      {...(inline ? { display: "inline-flex" as "flex" } : {})}
      paddingTop={2}
      paddingRight={8}
      paddingBottom={2}
      paddingLeft={7}
      borderRadius={lengthToken(t, "control-radius-sm", 5)}
      backgroundColor={ground as never}
      {...(title !== undefined ? ({ title } as object) : {})}
    >
      {dot ? <View width={6} height={6} borderRadius={999} flexShrink={0} backgroundColor={t.v(ink) as never} /> : null}
      {/* Inline in a hint, the pill's words take the hint's line (1.4); elsewhere the body's. */}
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: ink, ...(inline ? { lineHeight: 1.4 } : {}), ...(weight !== undefined ? { weight } : {}) }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** `.cx-src`: where something comes from, as a small tag — with its tooltip, where the DOM's has one. */
export function SourceTag({ children, first = false, title }: { children: ReactNode; first?: boolean; title?: string }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 500, color: "tok-hint" }} {...(first ? {} : { marginLeft: 6 })} {...(title !== undefined ? { title } : {})} paddingHorizontal={5} borderRadius={999} backgroundColor={t.v("panel-2") as never} numberOfLines={1}>
      {children}
    </Txt>
  );
}

/**
 * `icons.tsx`'s `BrandIcon`: a company's mark in its colour (or `currentColor`), or its initial on its
 * colour. `ink` is that `currentColor`: the text's, or a composer chip's (--tok-hint, --accent on a
 * value you chose).
 */
export function BrandIcon({ name, size, ink: tone = "text" }: { name: string; size: number; ink?: string }): JSX.Element {
  const t = useTokens();
  const company = brandOf(name);
  const mark = brandMark(company);
  const ink = String(t.v(tone));
  if (mark !== undefined) {
    return <Svg width={size} height={size} color={ink} fill={mark.onGround === true ? "currentColor" : mark.hex} strokeWidth={0} shapes={[{ kind: "path", d: mark.path }]} />;
  }
  const hex = brandHex(company);
  const k = size / 24;
  return (
    <View width={size} height={size} borderRadius={6 * k} alignItems="center" justifyContent="center" backgroundColor={(hex ?? t.mix(ink, 18, "transparent")) as never} {...(hex !== undefined ? { opacity: 0.9 } : {})}>
      <Txt spec={{ voice: "app", scale: 1, weight: 600, color: hex === undefined ? ink : "#fff", lineHeight: { px: size } }} fontSize={13 * k} fontFamily="system-ui, sans-serif" textAlign="center">
        {company.charAt(0).toUpperCase()}
      </Txt>
    </View>
  );
}

/** `.cfg-mark`: a mark with its state's dot on the corner. */
export function Mark({ brand, state }: { brand: string; state: "available" | "unavailable" | "unconfigured" | "needs-sign-in" | "off" | "unchecked" }): JSX.Element {
  const t = useTokens();
  const dot = state === "available" ? "ok" : state === "unavailable" ? "bad" : state === "needs-sign-in" || state === "unconfigured" ? "warn" : "dim";
  return (
    <View position="relative" width={20} height={20} flexShrink={0} alignItems="center" justifyContent="center">
      <BrandIcon name={brand} size={17} />
      <View position="absolute" left={-2} top={-2} width={8} height={8} borderRadius={999} backgroundColor={t.v(dot) as never} {...({ boxShadow: `0 0 0 2px ${String(t.v("bg"))}` } as object)} />
    </View>
  );
}

/** A 1px --line above, for a list's rows (`li + li`). */
export function RowRule(): JSX.Element {
  const t = useTokens();
  return <View height={0} {...(edge(t, { top: 1 }) as object)} />;
}
