/**
 * Drawing an artboard into a DOM element, live: the page's own boot uses it, and so may a host that
 * draws an artboard which is not the page (the canvas editor).
 */

import { createElement, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parse } from "./parse.js";
import { DocView, createLoader, compile, recompile, type Compiled, type RenderEnv } from "./render.js";
import { isArtboardLink, isExternal, resolveCanvasPath } from "./paths.js";

export interface MountOptions {
  /** Props over the declared defaults: the Tweaks' values. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** `"play"` follows links; `"edit"` runs events but never follows a link. Default `"play"`. */
  readonly mode?: "play" | "edit";
  /** The artboard's canvas path, which imports and links resolve against. Default `Main.dc.html`. */
  readonly path?: string;
  /** A sibling file's source, by canvas path, for `<dc-import>`. */
  readonly resolve?: (path: string) => Promise<string>;
  /** A link to another artboard was followed, as a canvas path. Default: post `dc:navigate` to the parent window. */
  readonly onNavigate?: (path: string) => void;
  /** A file failed to parse, compile or render. */
  readonly onError?: (message: string) => void;
  /** The first render is on screen. */
  readonly onReady?: () => void;
  /** Where `<helmet>`'s children go. Default the document's `<head>`. */
  readonly helmetTarget?: Element;
}

export interface DCMount {
  /** Draws a new source for the same artboard. An unchanged script keeps the component's `state`. */
  update(source: string): void;
  /** Replaces the props given over the defaults (not merged with the last ones). */
  setProps(props: Readonly<Record<string, unknown>>): void;
  /** Forgets the imported files and draws everything again from their sources. */
  reload(): void;
  unmount(): void;
}

export function mount(container: Element, source: string, options: MountOptions = {}): DCMount {
  const mode = options.mode ?? "play";
  const path = options.path ?? "Main.dc.html";
  const onError = options.onError ?? ((text: string) => console.error(`[dc] ${text}`));
  const onNavigate = options.onNavigate ?? ((target: string) => post({ type: "dc:navigate", href: target }));
  const makeEnv = (): RenderEnv => {
    const env: RenderEnv = {
      mode,
      helmet: "portal",
      helmetTarget: options.helmetTarget ?? document.head,
      loader: createLoader(() => env, options.resolve ? { resolve: options.resolve } : {}),
      onError,
    };
    return env;
  };
  let env = makeEnv();
  let compiled: Compiled = compile(parse(source), path, env);
  let props: Readonly<Record<string, unknown>> = options.props ?? {};
  let generation = 0;
  let readyPending = options.onReady !== undefined;

  const root = createRoot(container, { onUncaughtError: (cause) => onError(cause instanceof Error ? cause.message : String(cause)) });
  const draw = (): void => {
    root.render(
      createElement(
        Ready,
        { onReady: firstReady },
        createElement(DocView, { key: generation, compiled, props, env }),
      ),
    );
  };
  function firstReady(): void {
    if (!readyPending) return;
    readyPending = false;
    // One frame later, so layout (and a size read from it) reflects the render.
    requestAnimationFrame(() => options.onReady?.());
  }

  const onClick = (event: Event): void => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest("a[href]");
    if (!target || !anchor || !container.contains(anchor)) return;
    event.preventDefault();
    // format.md: "a `<button>` or input inside it swallows the click" — its own handler ran; the link does not.
    const inner = target.closest("button, input, select, textarea");
    if (inner && anchor.contains(inner)) return;
    if (mode === "edit") return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      scrollToFragment(container, href.slice(1));
    } else if (isExternal(href)) {
      if (/^(https?|mailto|tel):/i.test(href)) window.open(href, "_blank", "noopener");
    } else if (isArtboardLink(href)) {
      onNavigate(resolveCanvasPath(path, href));
    }
  };
  container.addEventListener("click", onClick);
  draw();

  return {
    update(next) {
      compiled = recompile(compiled, parse(next), env);
      draw();
    },
    setProps(next) {
      props = next;
      draw();
    },
    reload() {
      env = makeEnv();
      compiled = compile(compiled.holder.doc, path, env);
      generation++;
      draw();
    },
    unmount() {
      container.removeEventListener("click", onClick);
      root.unmount();
    },
  };
}

/** Calls `onReady` after the tree's first commit. */
function Ready({ onReady, children }: { onReady: () => void; children?: ReactNode }): ReactNode {
  useEffect(() => onReady(), [onReady]);
  return children;
}

function scrollToFragment(container: Element, fragment: string): void {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // Kept as written.
  }
  if (id === "" || id === "top") {
    (container.firstElementChild ?? container).scrollIntoView({ block: "start" });
    return;
  }
  const target = container.querySelector(`[id="${CSS.escape(id)}"]`) ?? container.querySelector(`a[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** A message to the window this frame is in, if it is in one. */
export function post(message: Record<string, unknown>): void {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}
