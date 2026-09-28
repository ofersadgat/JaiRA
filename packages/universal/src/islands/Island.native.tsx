import { useRef, useState, type JSX } from "react";
import { Platform } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Paths } from "expo-file-system";
import { useLook } from "../tokens";
import type { IslandProps } from "./types";

/**
 * An island on NATIVE (decision 0013, S5): the island page for `component`, bundled with the app by
 * `plugins/withIslands.js` and loaded from `file://`, driven over the bridge in
 * `packages/client/island/protocol.ts`.
 *
 * The page is built classic (one IIFE, no modules, fonts inlined, blob workers) precisely so that it
 * needs no file-access-from-file-URLs permission: `shots/islands.mts --strict` shows it loading under
 * the rules a WebView applies by default. `allowFileAccess` is still needed to read the page itself.
 */
function pageOf(component: IslandProps["component"]): string {
  if (Platform.OS === "android") return `file:///android_asset/island/${component}/index.html`;
  // iOS: the folder the plugin adds to the app bundle as a folder reference.
  return `${Paths.bundle.uri.replace(/\/?$/, "/")}island/${component}/index.html`;
}

export function Island({ component, props, height, onEvent }: IslandProps): JSX.Element {
  const web = useRef<WebView>(null);
  const look = useLook();
  const [measured, setMeasured] = useState(1);
  const render = JSON.stringify({ kind: "render", component, props, look: { palette: look.palette, theme: look.scheme, wash: look.wash } });

  const receive = (e: WebViewMessageEvent): void => {
    const message = JSON.parse(e.nativeEvent.data) as { kind: string; px?: number; name?: string; value?: unknown };
    if (message.kind === "ready") web.current?.postMessage(render);
    else if (message.kind === "height" && height === undefined && message.px !== undefined && message.px > 0) setMeasured(message.px);
    else if (message.kind === "event" && message.name !== undefined) onEvent?.(message.name, message.value);
  };

  const page = pageOf(component);
  return (
    <WebView
      ref={web}
      source={{ uri: page }}
      originWhitelist={["*"]}
      allowFileAccess
      allowingReadAccessToURL={page.slice(0, page.lastIndexOf("/island/") + "/island/".length)}
      onMessage={receive}
      // Sized to its content, a markdown island does not scroll itself: the screen around it does.
      scrollEnabled={height !== undefined}
      nestedScrollEnabled={height !== undefined}
      style={{ height: height ?? measured, backgroundColor: "transparent" }}
    />
  );
}
