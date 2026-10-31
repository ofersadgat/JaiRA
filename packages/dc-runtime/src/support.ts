/**
 * `support.js`: what every artboard's `<head>` loads (`<script src="./support.js"></script>`).
 *
 * Loaded in the head, it runs before the body is parsed, so it hides `<x-dc>` first — the raw template,
 * holes and all, must never show. Once the document is parsed it draws the component in the template's
 * place and talks to the window it is framed in (see README.md, "Messages").
 */

import { decodeEntities, setEntityFallback } from "./html.js";
import { editStyle, editText } from "./edit.js";
import { mount, post, type DCMount } from "./mount.js";
import { parse } from "./parse.js";
import { encodeCanvasPath, pagePlace, resolveCanvasPath } from "./paths.js";

const hide = document.createElement("style");
hide.setAttribute("data-dc-runtime", "");
hide.textContent = "x-dc{display:none!important}";
(document.head ?? document.documentElement).appendChild(hide);

// The browser knows every named character reference; the parser's own table holds the common ones.
setEntityFallback((name) => {
  const probe = document.createElement("textarea");
  probe.innerHTML = `&${name};`;
  return probe.value === `&${name};` ? undefined : probe.value;
});

const DC = { version: "0.2.47", parse, editStyle, editText, mount, resolveCanvasPath, decodeEntities };
(window as unknown as { DC: typeof DC }).DC = DC;

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
else void boot();

/** Draws the page's own component, if the page has one; a page that only loads `DC` (a host) has none. */
async function boot(): Promise<void> {
  const xdc = document.querySelector("x-dc");
  if (!xdc) return;
  const source = await pageSource();
  const place = pagePlace(location.pathname);
  const root = new URL(place.root, location.href);
  const urlOf = (path: string): string => new URL(encodeCanvasPath(path), root).href;

  const container = document.createElement("div");
  container.setAttribute("data-dc-root", "");
  // The template's top elements are the page's: a box of our own around them must not take part in layout.
  container.style.display = "contents";
  xdc.replaceWith(container);

  let artboard: DCMount | null = null;
  let text = source;
  const editing = editMode(() => text, container);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as { type?: unknown; props?: unknown; mode?: unknown; text?: unknown; id?: unknown } | null;
    // The mode is the page's, not the artboard's: kept even before the artboard is drawn.
    if (data?.type === "dc:mode" && (data.mode === "edit" || data.mode === "play" || data.mode === "view")) {
      editing.setMode(data.mode);
      return;
    }
    if (!artboard) return;
    if (data?.type === "dc:props" && data.props !== null && typeof data.props === "object") {
      artboard.setProps(data.props as Record<string, unknown>);
    } else if (data?.type === "dc:mode" && (data.mode === "edit" || data.mode === "play" || data.mode === "view")) {
      editing.setMode(data.mode);
    } else if (data?.type === "dc:source" && typeof data.text === "string") {
      // The editor's change, drawn in place: the same script keeps its class and its state.
      text = data.text;
      artboard.update(text);
      editing.afterRender();
    } else if (data?.type === "dc:select") {
      editing.select(typeof data.id === "number" ? data.id : null);
    }
  });
  window.addEventListener("error", (event) => post({ type: "dc:error", message: event.message }));

  artboard = mount(container, source, {
    mode: "play",
    path: place.path,
    resolve: async (path) => {
      const response = await fetch(urlOf(path));
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      return response.text();
    },
    onNavigate: (href) => post({ type: "dc:navigate", href, url: urlOf(href) }),
    onError: (message) => {
      console.error(`[dc] ${message}`);
      post({ type: "dc:error", message });
    },
    // `dc:ready` a frame after this render, and after every later one (`afterRender`).
    onReady: () => editing.afterRender(),
  });
}

/**
 * The editor's hold on the page (README, "Edit mode"). In `edit` the pointer belongs to the editor:
 * every press, click and key is caught on the way down (the capture phase, at the window) and stopped,
 * so the design's own handlers and links never run, and what is under the pointer is reported by its
 * template element's id. `play` and `view` let the page be itself.
 */
function editMode(source: () => string, container: Element): { setMode: (mode: "edit" | "play" | "view") => void; select: (id: number | null) => void; afterRender: () => void } {
  let mode: "edit" | "play" | "view" = "view";
  let selected: number | null = null;
  let hoverFrame = 0;

  /** The innermost element the editor can name, under an event's target. */
  const named = (target: EventTarget | null): HTMLElement | null => {
    const el = target instanceof Element ? target.closest("[data-dc-id]") : null;
    return el instanceof HTMLElement || el instanceof SVGElement ? (el as HTMLElement) : null;
  };
  const rectOf = (el: Element): { x: number; y: number; width: number; height: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  };
  const idOf = (el: Element): number => Number(el.getAttribute("data-dc-id"));
  /** The element's inline style and literal text as the SOURCE has them — holes and all, not as drawn. */
  const fromSource = (n: number): { style: string; text: string | null; tag: string } => {
    const text = source();
    const el = parse(text).elements[n];
    if (!el) return { style: "", text: null, tag: "div" };
    return {
      tag: el.tag,
      style: el.style ? decodeEntities(text.slice(el.style.start, el.style.end)) : "",
      text: el.text ? decodeEntities(text.slice(el.text.start, el.text.end)) : null,
    };
  };

  const stop = (event: Event): void => {
    if (mode !== "edit") return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "contextmenu", "submit", "keydown", "keyup", "input", "change", "focusin"]) {
    window.addEventListener(type, stop, true);
  }
  window.addEventListener(
    "click",
    (event) => {
      if (mode !== "edit") return;
      stop(event);
      const el = named(event.target);
      if (!el) return;
      const n = idOf(el);
      post({ type: "dc:pick", id: n, rect: rectOf(el), shift: event.shiftKey, ...fromSource(n) });
    },
    true,
  );
  window.addEventListener(
    "dblclick",
    (event) => {
      if (mode !== "edit") return;
      stop(event);
      const el = named(event.target);
      if (el) post({ type: "dc:dblclick", id: idOf(el), rect: rectOf(el), ...fromSource(idOf(el)) });
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (mode !== "edit") return;
      cancelAnimationFrame(hoverFrame);
      const target = event.target;
      hoverFrame = requestAnimationFrame(() => {
        const el = named(target);
        post({ type: "dc:hover", id: el ? idOf(el) : null, rect: el ? rectOf(el) : null });
      });
    },
    true,
  );

  /** The selected element's box, wherever a render or a resize moved it. */
  const reportSelected = (): void => {
    if (selected === null) return;
    const el = container.querySelector(`[data-dc-id="${String(selected)}"]`);
    post({ type: "dc:rects", rects: el ? { [String(selected)]: rectOf(el) } : {} });
  };
  new ResizeObserver(reportSelected).observe(document.documentElement);

  return {
    setMode: (next) => {
      mode = next;
      document.documentElement.style.cursor = next === "edit" ? "default" : "";
    },
    select: (id) => {
      selected = id;
      reportSelected();
    },
    afterRender: () => {
      // A frame later: React has committed, and the browser has laid the new tree out.
      requestAnimationFrame(() => {
        post({ type: "dc:ready", size: measure(container) });
        reportSelected();
      });
    },
  };
}

/**
 * The page's source as written. The DOM is not it: the browser has lowercased `onClick`, moved what
 * it did not expect out of tables, and kept no offsets. So the file is read again from where it was
 * served; only when that fails (a `data:` or `about:srcdoc` page, a server without CORS for an opaque
 * origin) is the DOM serialized instead — right for nearly every artboard, and taken before anything
 * here changes it.
 */
async function pageSource(): Promise<string> {
  const snapshot = `<!doctype html>\n${document.documentElement.outerHTML}`;
  try {
    const response = await fetch(location.href, { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      if (/<x-dc[\s>]/i.test(text)) return text;
    }
  } catch {
    // The snapshot, below.
  }
  return snapshot;
}

/**
 * The size a frame needs to show what was drawn: from the page's corner to the far edges of the
 * template's top elements (so a body margin counts, as it does in the frame).
 */
function measure(container: Element): { width: number; height: number } {
  const boxes = Array.from(container.children, (el) => el.getBoundingClientRect());
  if (boxes.length === 0) return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
  return {
    width: Math.ceil(Math.max(...boxes.map((box) => box.right)) + window.scrollX),
    height: Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + window.scrollY),
  };
}
