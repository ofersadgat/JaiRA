import type { JSX } from "react";
import { Text, View, isWeb } from "@tamagui/core";
import type { MachineChipState } from "@jaira/ui/machineChip";
import { faceOf } from "../primitives";
import { useTokens } from "../tokens";

/**
 * `machineChip.tsx`'s `MachineChip`, universal (decision 0013): where something runs. The rules it
 * takes, in the order they win (all one class, so the later rule in the file wins a tie):
 *
 *   .chip            10/12.5 of --size-app, --dim, 1px --line, radius 999, padding 0 6, nowrap, flex none
 *   .mchip           inline-flex, centred, gap 5, --text (over .chip's --dim: later in the file)
 *   .mchip-off/none  --dim; none is dashed
 *   .mchip-dot       6×6 round, --ok; hollow (1px --dim) off, --warn warn, dashed hollow none
 *
 * The family, the weight and the line height are inherited in the DOM, so they are passed in here: a
 * card's meta line is the data voice at 400 on 1.5 (the defaults); a settings row's name (`.set-name`)
 * is the app voice at 550 on 1.3.
 */
export function MachineChip({
  label,
  state = "on",
  title,
  voice,
  weight = 400,
  line = 1.5,
}: {
  label: string;
  state?: MachineChipState;
  title?: string;
  /** The family the chip sits in (`--font-data` in a card's meta line). */
  voice: string;
  /** The weight and line height it inherits there. */
  weight?: number;
  line?: number;
}): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-app", 10 / 12.5);
  const ink = state === "off" || state === "none" ? t.v("dim") : t.v("text");
  // On a phone the stack is no family: the cut face of whichever voice it is (`faceOf`).
  const face = isWeb ? { fontFamily: voice, ...(weight !== 400 ? { fontWeight: String(weight) } : {}) } : faceOf(t, voice === String(t.v("font-data")) ? "data" : "app", weight, size);
  const dot =
    state === "on"
      ? { backgroundColor: t.v("ok") }
      : state === "warn"
        ? { backgroundColor: t.v("warn") }
        : { backgroundColor: "transparent", borderWidth: 1, borderColor: t.v("dim"), borderStyle: state === "none" ? "dashed" : "solid" };
  return (
    <View
      render="span"
      {...((isWeb ? { title: title ?? label } : {}) as object)}
      display={isWeb ? ("inline-flex" as "flex") : "flex"}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingHorizontal={6}
      borderWidth={1}
      borderColor={t.v("line") as never}
      borderStyle={state === "none" ? "dashed" : "solid"}
      borderRadius={999}
      flexGrow={0}
      flexShrink={0}
    >
      <View width={6} height={6} borderRadius={3} flexShrink={0} {...(dot as object)} />
      <Text
        {...({ ...face, fontSize: size, lineHeight: isWeb ? String(line) : Number(size) * line } as object)}
        {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}
        color={ink as never}
      >
        {label}
      </Text>
    </View>
  );
}
