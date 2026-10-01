import type { JSX, ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * A word or a count in a pill, as the Files room wears it (the tree's lint counts, "shadowed",
 * "override", the Built in root's "edits copy to Shared"; the address bar's error counts and "built
 * in"). How it looks:
 *
 *   the pill     10/12.5 of --size-app, --dim, 1px --line, radius 999, padding 0 6, one line, never
 *                growing or shrinking
 *   `bad`        --bad, and its ring
 *   `warn`       --warn, and its ring
 *
 * The weight and line height are those of the row it stands in (the tree's: the app voice at 1.5, 600
 * on the selected row), so they come in as `spec`.
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
