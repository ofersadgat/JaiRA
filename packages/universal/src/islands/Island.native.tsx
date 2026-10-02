import { useEffect, useRef, useState, type JSX } from "react";
import { Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Paths } from "expo-file-system";
import { useLook } from "../tokens";
import type { IslandProps } from "./types";

/**
 * An island on NATIVE (decision 0015, S5): the island page for `component`, bundled with the app by
 * `plugins/withIslands.cjs` and loaded from `file://`, driven over the bridge in
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

type Fn = (...args: unknown[]) => unknown;
type Rect = { top: number; bottom: number; left: number; right: number };

/**
 * The props as they can travel: each function replaced by `{"$call": path}` and kept in `into`, so the
 * island can call it back (the diff's `intel.modified.check`, the code editor's `intel.check` and its
 * neighbours). Plain objects and arrays are walked.
 */
function encode(value: unknown, path: string, into: Map<string, Fn>): unknown {
  if (typeof value === "function") {
    into.set(path, value as Fn);
    return { $call: path };
  }
  if (Array.isArray(value)) return value.map((v, i) => encode(v, `${path}.${i}`, into));
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, encode(v, path === "" ? k : `${path}.${k}`, into)]));
}

/** A rect an event carries (a selection's), wherever it sits in the value. */
function rectIn(value: unknown): Rect | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as { rect?: Rect; selection?: { rect?: Rect } | null };
  return v.rect ?? v.selection?.rect ?? undefined;
}

export function Island({ component, props, height, appearance, onEvent, onReport, handle }: IslandProps): JSX.Element {
  const web = useRef<WebView>(null);
  /** The box round the page, measured in the window for a rect the page reports. */
  const box = useRef<View>(null);
  /** The box's width as it was laid out, before any scale a host draws it at. */
  const laid = useRef(0);
  const look = useLook();
  const [measured, setMeasured] = useState(1);
  /** Whether the page has said `ready` — before it, a render has nowhere to go. */
  const ready = useRef(false);
  /** How many events have come back: a render says it, so the island can tell a stale one (`host.tsx`). */
  const heard = useRef(0);
  /** The functions among the props, by path — the latest render's, so a call reaches today's closure. */
  const fns = useRef(new Map<string, Fn>());
  const found = new Map<string, Fn>();
  const body = JSON.stringify({ component, props: encode(props, "", found), look: { palette: look.palette, theme: look.scheme, wash: look.wash, ...(appearance === undefined ? {} : { appearance }) } });
  fns.current = found;
  const post = (): void => web.current?.postMessage(`{"kind":"render","echo":${heard.current},${body.slice(1)}`);
  const latest = useRef({ onEvent, handle });
  latest.current = { onEvent, handle };

  // Props and look moved (the draft after an edit, a revert, a palette switch): draw them.
  useEffect(() => {
    if (ready.current) post();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  // Withdrawn with the page: a command posted after would go nowhere.
  useEffect(() => () => latest.current.handle?.(null), []);

  const receive = (e: WebViewMessageEvent): void => {
    const message = JSON.parse(e.nativeEvent.data) as { kind: string; px?: number; name?: string; value?: unknown; id?: number; fn?: string; args?: unknown[] };
    onReport?.(message);
    if (message.kind === "ready") {
      ready.current = true;
      post();
      latest.current.handle?.({ command: (name, value) => web.current?.postMessage(JSON.stringify({ kind: "command", name, value })) });
    } else if (message.kind === "height" && height === undefined && message.px !== undefined && message.px > 0) setMeasured(message.px);
    else if (message.kind === "event" && message.name !== undefined) {
      heard.current += 1;
      const name = message.name;
      const rect = rectIn(message.value);
      if (rect === undefined) {
        onEvent?.(name, message.value);
        return;
      }
      // A rect is the island page's; what the host places against it (a float) is placed in the window —
      // at the window's scale, which is not the page's while the shell is drawn fitted to a phone
      // (`DesktopFrame` scales it to a third): the box as the window measures it over the box as it was
      // laid out says by how much.
      box.current?.measureInWindow((x: number, y: number, width: number) => {
        const k = laid.current > 0 && width > 0 ? width / laid.current : 1;
        rect.top = y + rect.top * k;
        rect.bottom = y + rect.bottom * k;
        rect.left = x + rect.left * k;
        rect.right = x + rect.right * k;
        latest.current.onEvent?.(name, message.value);
      });
    } else if (message.kind === "call" && message.id !== undefined) {
      const id = message.id;
      const fn = fns.current.get(message.fn ?? "");
      const answer = (reply: { value?: unknown; error?: string }): void => web.current?.postMessage(JSON.stringify({ kind: "return", id, ...reply }));
      if (fn === undefined) {
        answer({ error: `nothing to call at ${message.fn ?? ""}` });
        return;
      }
      Promise.resolve()
        .then(() => fn(...(message.args ?? [])))
        .then(
          (value) => answer({ value }),
          (error: unknown) => answer({ error: error instanceof Error ? error.message : String(error) }),
        );
    }
  };

  const page = pageOf(component);
  // The height is the BOX's, and the page fills it. react-native-webview puts a container of its own
  // round the page (`flex: 1`: a basis of zero), and under the phone's strict layout (`StrictLayout.tsx`)
  // a box sized by its content is as tall as its children's bases — nothing. Offered a settled height
  // (`IslandBand`), the box, the container and the page all stood 0 tall and the Files room's editors
  // were blank; only in a scroller, which offers no height, did the page's own height hold them open.
  const tall = height ?? measured;
  return (
    <View ref={box} collapsable={false} style={{ height: tall }} onLayout={(e) => (laid.current = e.nativeEvent.layout.width)}>
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
        style={{ height: tall, backgroundColor: "transparent" }}
      />
    </View>
  );
}
