import { StrictMode, useEffect, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import "@jaira/ui/styles.css";
import type { FromIsland, IslandLook, ToIsland } from "./protocol";

/**
 * An island page's host (decision 0015, S5): one of the renderer's DOM components, drawn from props
 * that arrive over the bridge (`protocol.ts`), in a WebView on native and an iframe in the test
 * harness. The component is today's, unchanged; only its host is new. Each component has its own page
 * (`markdown.tsx`, `diff.tsx`, `markdownEditor.tsx`, `code.tsx`, `schemaText.tsx`, `artifact.tsx`), so an island
 * carries only what it draws.
 */
const start = performance.now();

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

function send(message: FromIsland): void {
  const text = JSON.stringify(message);
  if (window.ReactNativeWebView !== undefined) window.ReactNativeWebView.postMessage(text);
  else window.parent.postMessage(text, "*");
}

// A console warning is how Monaco says it could not start a worker and fell back to the main thread;
// the host is told, because that fallback is one of the things an island is measured on.
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    send({ kind: "log", level, text: args.map(String).join(" ").slice(0, 500) });
    original(...args);
  };
}
window.addEventListener("error", (e) => send({ kind: "error", message: e.message }));

/** How many distinct text colours are on screen: 1–2 is plain text, many is a grammar at work. */
function inks(): number {
  const seen = new Set<string>();
  for (const el of document.querySelectorAll("#island span")) seen.add(getComputedStyle(el).color);
  return seen.size;
}

/** This island's JavaScript heap, where the engine says (Chromium's `performance.memory`); 0 elsewhere. */
function heap(): number {
  return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
}

/** What a page draws: the component, from the props a render carries, and what counts as drawn. */
export interface IslandPage {
  /** The selector that must match before the component counts as drawn. */
  drawn: string;
  draw(props: Record<string, unknown>, event: (name: string) => (value: unknown) => void): JSX.Element;
  /**
   * Apply what of the look the page's component reads beyond the palette (`IslandLook.appearance`)
   * — the editor islands' fonts, editor palette and editor looks. Called on every render, before it
   * is drawn, after the palette and scheme are on the root.
   */
  look?(look: IslandLook): void;
}

function applyLook(look: IslandLook): void {
  const root = document.documentElement;
  if (look.palette === "classic") delete root.dataset["palette"];
  else root.dataset["palette"] = look.palette;
  root.dataset["theme"] = look.theme;
  if (look.wash === true) root.dataset["wash"] = "on";
  else delete root.dataset["wash"];
}

function Island({ page }: { page: IslandPage }): JSX.Element | null {
  const [render, setRender] = useState<ToIsland | null>(null);
  const asked = useRef(0);
  /** How many events this island has sent — what a render's `echo` is measured against. */
  const emitted = useRef(0);

  useEffect(() => {
    const receive = (e: MessageEvent): void => {
      const message = (typeof e.data === "string" ? JSON.parse(e.data) : e.data) as ToIsland;
      if (message?.kind !== "render") return;
      applyLook(message.look);
      page.look?.(message.look);
      asked.current = performance.now();
      /**
       * A render built before the host had seen this island's latest event is STALE: its props are
       * the island's own earlier state coming back. An editor typed into quickly sends `a`, then
       * `ab`; the host's render for `a` arrives after `ab` was typed, and drawing it would take the
       * `b` back out. So a stale render moves the look and keeps the props the island has.
       */
      if (message.echo !== undefined && message.echo < emitted.current) {
        setRender((drawn) => (drawn === null ? message : { ...drawn, look: message.look }));
        return;
      }
      setRender(message);
    };
    window.addEventListener("message", receive);
    // Android's WebView delivers `postMessage` on the document.
    document.addEventListener("message", receive as EventListener);
    send({ kind: "ready", ms: Math.round(performance.now() - start) });
    return () => {
      window.removeEventListener("message", receive);
      document.removeEventListener("message", receive as EventListener);
    };
  }, []);

  // Drawn once the component's content is actually on screen, not when React committed.
  useEffect(() => {
    if (render === null) return;
    let frame = 0;
    const look = (): void => {
      if (document.querySelector(page.drawn) !== null) {
        // Grammars colour asynchronously; give them two frames past first paint before counting.
        const ms = Math.round(performance.now() - asked.current);
        setTimeout(() => send({ kind: "drawn", ms, colours: inks(), heap: heap() }), 250);
      }
      else frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [render]);

  if (render === null) return null;
  return page.draw(render.props, (name) => (value) => {
    emitted.current += 1;
    send({ kind: "event", name, value });
  });
}

/** Mount `page` as this document's island. */
export function mountIsland(page: IslandPage): void {
  const host = document.getElementById("island")!;
  // The content's height, for a host that sizes the WebView to it (the markdown island). Editors fill
  // a fixed region instead, as they do on the desktop, and scroll inside it.
  new ResizeObserver(() => send({ kind: "height", px: Math.ceil(host.getBoundingClientRect().height) })).observe(host);
  createRoot(host).render(
    <StrictMode>
      <Island page={page} />
    </StrictMode>,
  );
}
