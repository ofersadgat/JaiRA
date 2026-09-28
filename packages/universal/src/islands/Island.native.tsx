import { useEffect, useRef, useState, type JSX } from "react";
import { Platform } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Paths } from "expo-file-system";
import { useLook } from "../tokens";
import type { IslandProps } from "./types";

/**
 * An island on NATIVE (decision 0015, S5): the island page for `component`, bundled with the app by
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

export function Island({ component, props, height, appearance, onEvent, onReport }: IslandProps): JSX.Element {
  const web = useRef<WebView>(null);
  const look = useLook();
  const [measured, setMeasured] = useState(1);
  /** Whether the page has said `ready` — before it, a render has nowhere to go. */
  const ready = useRef(false);
  /** How many events have come back: a render says it, so the island can tell a stale one (`host.tsx`). */
  const heard = useRef(0);
  const body = JSON.stringify({ component, props, look: { palette: look.palette, theme: look.scheme, wash: look.wash, ...(appearance === undefined ? {} : { appearance }) } });
  const post = (): void => web.current?.postMessage(`{"kind":"render","echo":${heard.current},${body.slice(1)}`);

  // Props and look moved (the draft after an edit, a revert, a palette switch): draw them.
  useEffect(() => {
    if (ready.current) post();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const receive = (e: WebViewMessageEvent): void => {
    const message = JSON.parse(e.nativeEvent.data) as { kind: string; px?: number; name?: string; value?: unknown };
    onReport?.(message);
    if (message.kind === "ready") {
      ready.current = true;
      post();
    } else if (message.kind === "height" && height === undefined && message.px !== undefined && message.px > 0) setMeasured(message.px);
    else if (message.kind === "event" && message.name !== undefined) {
      heard.current += 1;
      onEvent?.(message.name, message.value);
    }
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
