import type { JSX } from "react";
import { Linking } from "react-native";
import type { WordPart } from "@jaira/ui/machinesModel";
import { Txt, type FontSpec } from "../../primitives";

/**
 * A settings sentence made of parts (`machinesModel.ts`'s `WordPart`), as `.set-desc` draws it: the
 * words in its font (app at 1.03, line 1.45, --dim), a value as `.set-desc code` (the data face at
 * 0.92em, --text), an error as `.upd-err` (--bad), a note as `.cfg-hint` (app 11/12.5, --dim), a link as
 * the browser's own (#0000ee, underlined) — opened outside the app.
 */
export function Words({ parts, spec = { voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" } }: { parts: readonly WordPart[]; spec?: Partial<FontSpec> }): JSX.Element {
  const scale = spec.scale ?? 1.03;
  return (
    <Txt spec={spec}>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          part
        ) : "code" in part ? (
          <Txt key={i} spec={{ ...spec, voice: "data", scale: (scale * 12.5 * 0.92) / 12, color: "text" }}>
            {part.code}
          </Txt>
        ) : "error" in part ? (
          <Txt key={i} spec={{ ...spec, color: "bad" }}>
            {part.error}
          </Txt>
        ) : "hint" in part ? (
          <Txt key={i} spec={{ ...spec, scale: 11 / 12.5, color: "dim" }}>
            {part.hint}
          </Txt>
        ) : (
          <Txt key={i} spec={{ ...spec, color: "#0000ee" }} textDecorationLine="underline" onPress={() => void Linking.openURL(part.href)}>
            {part.link}
          </Txt>
        ),
      )}
    </Txt>
  );
}
