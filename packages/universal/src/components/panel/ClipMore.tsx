import { useMemo, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { CLIP_CHARS, clipText } from "@jaira/ui/textRuns";
import { Txt } from "../../primitives";
import { Button } from "../settings/Button";

/**
 * A long text's reading, cut (`clipText`): what it draws, how much it left out, and a step to draw more
 * — each press five times as much, so a few presses reach any length and none lays out megabytes the
 * person did not ask for. A value (not text) is the JSON view's to fold (`jsonFold.ts`).
 */
export function useClip(text: string): { shown: string; rest: number; more: () => void } {
  const [limit, setLimit] = useState(CLIP_CHARS);
  const clip = useMemo(() => clipText(text, limit), [text, limit]);
  return { ...clip, more: () => setLimit((l) => l * 5) };
}

/**
 * `ClipMore`: under a cut text, how much it left out and the press that draws more (a row, centred,
 * gap 8, 6 above; the count data 11/12, --dim).
 */
export function ClipMore({ rest, onMore }: { rest: number; onMore: () => void }): JSX.Element | null {
  if (rest <= 0) return null;
  return (
    <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={8} marginTop={6}>
      <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>… {rest.toLocaleString()} more characters</Txt>
      <Button kind="quiet" onPress={onMore}>
        Show more
      </Button>
    </View>
  );
}
