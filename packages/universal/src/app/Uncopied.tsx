import type { JSX } from "react";
import { Text, View } from "@tamagui/core";
import { useTokens } from "../tokens";

/** A region, page or surface that nothing draws yet: a dashed box where it stands, saying its name. */
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
