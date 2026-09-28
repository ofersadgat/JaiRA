import type { JSX, ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `.chip`, as the Files room wears it (the tree's lint counts, "shadowed", "override", the Built in
 * root's "edits copy to Shared"; the address bar's error counts and "built in"). The rules, from
 * `styles.css`:
 *
 *   .chip        10/12.5 of --size-app, --dim, 1px --line, radius 999, padding 0 6, nowrap, flex none
 *   .chip-bad    --bad, and its ring
 *   .chip-warn   --warn, and its ring
 *
 * The family, weight and line height are inherited in the DOM (the tree's rows: the app voice at 1.5,
 * 600 on the selected row), so they come in as `spec`.
 */
export function Chip({
  tone,
  title,
  spec,
  children,
  ...box
}: {
  tone?: "bad" | "warn" | undefined;
  title?: string | undefined;
  spec?: Partial<FontSpec>;
  children: ReactNode;
} & Record<string, unknown>): JSX.Element {
  const t = useTokens();
  const ink = tone ?? "dim";
  return (
    <View
      {...((isWeb && title !== undefined ? { title } : {}) as object)}
      flexDirection="row"
      alignItems="center"
      paddingHorizontal={6}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v(tone ?? "line") as never}
      borderRadius={999}
      flexGrow={0}
      flexShrink={0}
      {...box}
    >
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: ink, ...spec }} {...((isWeb ? { whiteSpace: "nowrap" } : { numberOfLines: 1 }) as object)}>
        {children}
      </Txt>
    </View>
  );
}
