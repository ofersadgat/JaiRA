import type { JSX } from "react";
import { Text, View } from "@tamagui/core";
import { useTokens } from "../tokens";

/** A region with no copy yet: its name, where it stands (decision 0015). */
export function Uncopied({ name, ...box }: { name: string; width?: number; height?: number; flex?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View
      {...box}
      testID={`uncopied-${name}`}
      borderWidth={1}
      borderStyle="dashed"
      borderColor={t.v("dim") as never}
      alignItems="center"
      justifyContent="center"
      padding={8}
    >
      <Text fontSize={12} color={t.v("dim") as never}>
        {name} (not copied yet)
      </Text>
    </View>
  );
}
