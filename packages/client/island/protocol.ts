/**
 * The island bridge (decision 0013, S5): how a native screen (or, for testing, a web page) drives one
 * DOM component rendered in a WebView (or an iframe).
 *
 * Host → island, delivered as a `message` event (`WebView.postMessage` on native, `postMessage` into
 * an iframe on web):
 *   {kind: "render", component, props, look}   draw (or redraw) with these props, in this look
 * Island → host, through `window.ReactNativeWebView.postMessage` when it exists, else `window.parent`:
 *   {kind: "ready", ms}                        the page has loaded and can take a render
 *   {kind: "drawn", ms, colours}               the component has drawn what the last render asked for;
 *                                              `colours` counts the distinct ink of its text, which is
 *                                              how a host sees that the syntax grammars ran; `heap` is
 *                                              the island's JS heap in bytes, where the engine reports it
 *   {kind: "height", px}                       the content's height, whenever it changes (auto-sizing)
 *   {kind: "event", name, value}               a callback the component fired (`onChange`, a link)
 *   {kind: "log", level, text}                 a console warning or error, so the host can see fallbacks
 *   {kind: "error", message}                   the component threw
 *
 * Every frame is JSON text, because React Native's bridge carries strings.
 */
export type IslandComponent = "markdown" | "diff" | "markdownEditor";

export interface IslandLook {
  palette: string;
  theme: "light" | "dark";
  wash?: boolean;
}

export type ToIsland = { kind: "render"; component: IslandComponent; props: Record<string, unknown>; look: IslandLook };

export type FromIsland =
  | { kind: "ready"; ms: number }
  | { kind: "drawn"; ms: number; colours: number; heap: number }
  | { kind: "height"; px: number }
  | { kind: "event"; name: string; value: unknown }
  | { kind: "log"; level: "warn" | "error"; text: string }
  | { kind: "error"; message: string };
