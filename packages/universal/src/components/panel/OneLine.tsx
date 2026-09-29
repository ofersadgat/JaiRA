import { useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt, type FontSpec } from "../../primitives";

/**
 * A text on one line whatever its box — `white-space: nowrap`, which React Native does not have. On web
 * the rule itself; on a phone the text is measured on one line apart (in a wide, invisible box) and given
 * that width, so where its box is narrower it overflows and is clipped there, as the desktop's does
 * (the way `Crumbs.tsx` draws a project's path).
 */
export function OneLine({ spec, children, ...rest }: { spec: Partial<FontSpec>; children: ReactNode } & Record<string, unknown>): JSX.Element {
  const [natural, setNatural] = useState<number | null>(null);
  if (isWeb) {
    return (
      <Txt spec={spec} whiteSpace="nowrap" {...rest}>
        {children}
      </Txt>
    );
  }
  return (
    <>
      <Txt spec={spec} numberOfLines={1} {...rest} {...(natural !== null ? { width: natural } : {})}>
        {children}
      </Txt>
      <View position="absolute" left={0} top={0} width={4000} flexDirection="row" opacity={0} pointerEvents="none">
        <Txt spec={spec} numberOfLines={1} onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setNatural(Math.ceil(e.nativeEvent.layout.width))}>
          {children}
        </Txt>
      </View>
    </>
  );
}
