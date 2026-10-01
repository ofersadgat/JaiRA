import type { JSX } from "react";
import { View } from "@tamagui/core";
import { useTokens } from "../../tokens";

/**
 * Chromium's menulist arrow, for every select — the plain one (`logs/Select.tsx`) and a form's
 * (`settings/fields.tsx`) alike — measured off real `<select>`s: a right-angled chevron (its arms at
 * 45°) whose centre line is 8.2 wide and 4.1 tall, its right end 4.61 in from the box's right edge
 * and its middle 0.235 above the box's, stroked 1.5, in the text's colour; the same in every select,
 * whatever its font or height (measured in the Logs bar's, a settings page's and the New-task form's:
 * pixel for pixel alike). Drawn as its two strokes, meeting at the point — their square ends make the
 * miter's tip — so a phone draws it too.
 */
export function MenulistArrow({ color = "text" }: { color?: string }): JSX.Element {
  const t = useTokens();
  const ink = t.v(color) as never;
  const [w, h, stroke] = [8.2, 4.1, 1.5];
  const length = Math.hypot(w / 2, h) + stroke / 2;
  const angle = (Math.atan2(h, w / 2) * 180) / Math.PI;
  const bar = (cx: number, turn: number): JSX.Element => (
    <View position="absolute" left={cx - length / 2} top={h / 2 - stroke / 2} width={length} height={stroke} backgroundColor={ink} transform={[{ rotate: `${turn * angle}deg` }]} />
  );
  return (
    <View position="absolute" right={4.61} top="50%" marginTop={-h / 2 - 0.235} width={w} height={h} pointerEvents="none" aria-hidden>
      {bar(w / 4, 1)}
      {bar((3 * w) / 4, -1)}
    </View>
  );
}
