import type { JSX } from "react";

/**
 * The phone app's WebView, in a browser (decision 0013, ruling 6: One's browser rendering stands in
 * for the phone until a device is used): an iframe of the same page.
 */
export function WebFrame({ source, style }: { source: { uri: string }; style?: { flex?: number } }): JSX.Element {
  return <iframe src={source.uri} title="JaiRA desktop" style={{ flex: style?.flex ?? 1, border: 0, width: "100%", height: "100%" }} />;
}
