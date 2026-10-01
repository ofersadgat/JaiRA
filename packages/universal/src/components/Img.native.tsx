import type { JSX } from "react";
import { Image, View } from "react-native";
import { SvgXml } from "react-native-svg";

/**
 * `Img.tsx` on a phone. React Native's `Image` decodes bitmaps only: handed an SVG — which travels as
 * its own source in a `data:image/svg+xml` URI (`mediaSrcOf`) — it draws nothing and `Image.getSize`
 * fails, so a changed `.svg` in the changeset reviewer was a blank where its comparison should be. The
 * document is drawn with `react-native-svg` instead, stretched to the box as an `img` is (inside it the
 * drawing keeps its shape, by its own `preserveAspectRatio`, as an SVG in an `img` does), and its
 * natural size is read from its root: `width` and `height`, else its `viewBox`, else the 300 × 150 a
 * browser gives a replaced element with neither.
 */
export function Img({ src, alt, style }: { src: string; alt: string; style: Record<string, unknown> }): JSX.Element {
  const xml = svgOf(src);
  if (xml === undefined) return <Image source={{ uri: src }} accessibilityLabel={alt} resizeMode="stretch" style={style as never} />;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={alt} style={style as never}>
      <SvgXml xml={xml} width="100%" height="100%" />
    </View>
  );
}

export function naturalSizeOf(src: string, known: (width: number, height: number) => void, unknown: () => void): void {
  const xml = svgOf(src);
  if (xml === undefined) {
    Image.getSize(src, known, unknown);
    return;
  }
  const root = /<svg\b[^>]*>/i.exec(xml)?.[0];
  if (root === undefined) {
    unknown();
    return;
  }
  const length = (name: string): number | undefined => {
    const said = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(root)?.[1];
    return said === undefined ? undefined : Number(said);
  };
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root);
  const width = length("width") ?? (box !== null ? Number(box[1]) : 300);
  const height = length("height") ?? (box !== null ? Number(box[2]) : 150);
  // As `Image.getSize` answers: later, never inside the call.
  setTimeout(() => known(width, height), 0);
}

/** The SVG document a `data:` URI carries, percent-encoded or base64; nothing for any other picture. */
function svgOf(src: string): string | undefined {
  const m = /^data:image\/svg\+xml((?:;[^,;]*)*),/i.exec(src);
  if (m === null) return undefined;
  const body = src.slice(m[0].length);
  try {
    return /;base64$/i.test(m[1] ?? "") ? decodeURIComponent(escape(globalThis.atob(body))) : decodeURIComponent(body);
  } catch {
    return undefined;
  }
}
