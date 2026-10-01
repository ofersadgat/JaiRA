import type { JSX } from "react";
import { View } from "@tamagui/core";
import { Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";

/**
 * A gate answered here for a machine that is offline — the answer waits in the outbox, said under the
 * gate, with a way to take it back.
 *
 *   the strip        row, centred, gap 10, 10 above, padding 8 10, radius --control-radius, --tint-warn,
 *                    app 12/12.5
 *   its dot          8 round, a 1.5px --warn ring
 */
export function PendingSend({ machine, onTakeBack }: { machine: string; onTakeBack: () => void }): JSX.Element {
  const t = useTokens();
  const words = { voice: "app" as const, scale: 12 / 12.5 };
  return (
    <View flexDirection="row" alignItems="center" gap={10} marginTop={10} paddingVertical={8} paddingHorizontal={10} borderRadius={lengthToken(t, "control-radius", 7) as never} backgroundColor={t.v("tint-warn") as never}>
      <View width={8} height={8} borderRadius={999} borderWidth={1.5} borderStyle="solid" borderColor={t.v("warn") as never} flexShrink={0} />
      <Txt spec={words} flex={1} minWidth={0}>
        Your answer waits for <Txt spec={{ ...words, weight: 700 }}>{machine}</Txt>, which is offline. It is delivered when {machine} reconnects.
      </Txt>
      <Button kind="ghost" onPress={onTakeBack}>
        Take it back
      </Button>
    </View>
  );
}
