import { useEffect, useState, type JSX } from "react";
import { Image, type LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";

/**
 * An image as the DOM's `img` with `max-width: 100%` (and a `max-height`): its natural size, scaled down
 * to the width it is given, keeping its shape. Nothing until its size is known, as an `img` still loading.
 */
export function Picture({ src, alt, maxHeight, box, below = 0 }: { src: string; alt?: string; maxHeight?: number; box?: Record<string, unknown>; /** Space under it: the rest of its line box, for an image in a line of text. */ below?: number }): JSX.Element {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    Image.getSize(
      src,
      (width, height) => live && setNatural({ width, height }),
      () => live && setNatural(null),
    );
    return () => {
      live = false;
    };
  }, [src]);
  const scale = natural === null || room === null ? 0 : Math.min(1, room / natural.width, maxHeight !== undefined ? maxHeight / natural.height : 1);
  const width = natural === null ? 0 : natural.width * scale;
  const height = natural === null ? 0 : natural.height * scale;
  return (
    <View onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)} paddingBottom={below}>
      {natural !== null && room !== null ? <Image source={{ uri: src }} accessibilityLabel={alt ?? ""} resizeMode="stretch" style={{ width, height, ...(box as object) }} /> : null}
    </View>
  );
}
