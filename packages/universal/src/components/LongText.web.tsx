import type { JSX } from "react";
import { Txt } from "../primitives";

/** `LongText.tsx` in a browser: the one `Txt`, which draws only what shows. */
export function LongText({ text, ...txt }: { text: string } & Record<string, unknown>): JSX.Element {
  return <Txt {...txt}>{text}</Txt>;
}
