import type { JSX } from "react";
import { Image } from "react-native";

/**
 * An `img`, stretched to the box it is given, and how big its picture is by nature. On web both are
 * react-native-web's `Image`, whose element draws whatever a browser draws; a phone's `Image` cannot draw
 * an SVG (`Img.native.tsx`).
 */
export function Img({ src, alt, style }: { src: string; alt: string; style: Record<string, unknown> }): JSX.Element {
  return <Image source={{ uri: src }} accessibilityLabel={alt} resizeMode="stretch" style={style as never} />;
}

export function naturalSizeOf(src: string, known: (width: number, height: number) => void, unknown: () => void): void {
  Image.getSize(src, known, unknown);
}
