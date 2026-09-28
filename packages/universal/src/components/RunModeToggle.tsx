import type { JSX } from "react";
import { View } from "@tamagui/core";
import { Press, Txt } from "../primitives";
import { useTokens } from "../tokens";

type RunMode = "board" | "conversation";

/**
 * `runViews.tsx`'s `RunModeToggle`, universal (decision 0015): which reading of a drilled run is on screen,
 * its board or its conversation — two words in one ring. The rules, from `styles.css`:
 *
 *   .run-mode            row, 1px --line ring, radius 6, clipped
 *   .run-mode button     no ring, no radius, no ground, app voice at 12/12.5 (line 1.5), padding 4 11,
 *                        --dim; hovered: --panel-3 (`button:hover:not(:disabled)`, (0,2,1), outranks it)
 *   .run-mode button.on  --panel-2 ground, --text — later than the hover rule at the same (0,2,1), so
 *                        the one that is on keeps its ground under the pointer
 */
export function RunModeToggle({ mode, onMode }: { mode: RunMode; onMode: (mode: RunMode) => void }): JSX.Element {
  const t = useTokens();
  const one = (value: RunMode, words: string): JSX.Element => {
    const on = mode === value;
    return (
      <Press
        onPress={() => onMode(value)}
        label={words}
        {...({ "aria-pressed": on } as object)}
        paddingVertical={4}
        paddingHorizontal={11}
        box={({ hovered }) => ({ backgroundColor: on ? t.v("panel-2") : hovered ? t.v("panel-3") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: on ? "text" : "dim" }} whiteSpace="nowrap">
          {words}
        </Txt>
      </Press>
    );
  };
  return (
    <View flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden">
      {one("board", "Tasks")}
      {one("conversation", "Conversation")}
    </View>
  );
}
