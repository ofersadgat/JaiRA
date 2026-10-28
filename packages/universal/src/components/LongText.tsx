import { useMemo, type JSX } from "react";
import { View } from "@tamagui/core";
import { textRuns } from "@jaira/ui/textRuns";
import { Txt } from "../primitives";
import { Virtual } from "./Virtual";

/**
 * A text of any length, as a `Txt` with these props would draw it — on a phone cut into runs
 * (`textRuns.ts`), each its own text view mounted only near the screen (`Virtual`), so no one view is
 * longer than a run. Short, it is one `Txt`. Line breaks the cuts make fall where lines broke anyway,
 * but for a line longer than a run. `LongText.web.tsx` is the one `Txt`.
 */
export function LongText({ text, ...txt }: { text: string } & Record<string, unknown>): JSX.Element {
  const runs = useMemo(() => textRuns(text), [text]);
  if (runs.length === 1) return <Txt {...txt}>{text}</Txt>;
  return (
    <View flexDirection="column" minWidth={0}>
      {runs.map((run, i) => (
        <Virtual key={i}>
          <Txt {...txt}>{run}</Txt>
        </Virtual>
      ))}
    </View>
  );
}
