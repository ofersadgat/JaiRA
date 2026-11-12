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
    const data = event.data as { type?: unknown; props?: unknown; mode?: unknown; text?: unknown; id?: unknown; req?: unknown } | null;
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
    } else if (data?.type === "dc:measure") {
      editing.measure(data.req);
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
function editMode(source: () => string, container: Element): { setMode: (mode: "edit" | "play" | "view") => void; select: (id: number | null) => void; afterRender: () => void; measure: (req: unknown) => void } {
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

  /**
   * The middle button pans the canvas, whatever the mode: a press inside a frame is the frame's, so the
   * drag is told to the host rather than started here — WHERE the pointer is, in this frame's own pixels
   * (`dc:pan`, `phase` start | move | end), which the host places in its window by where the frame stands
   * as it reads it. Not how far it moved: the host pans the frame under the pointer as it goes, and a
   * distance measured here is measured against a frame that has since moved (40 px panned 26, or 119).
   * Registered first, so no edit-mode listener sees it, and the browser's own autoscroll never starts.
   */
  let panning = false;
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      panning = true;
      post({ type: "dc:pan", phase: "start", x: event.clientX, y: event.clientY });
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!panning) return;
      event.stopImmediatePropagation();
      post({ type: "dc:pan", phase: "move", x: event.clientX, y: event.clientY });
    },
    true,
  );
  const panEnds = (event: PointerEvent): void => {
    if (!panning || event.button !== 1) return;
    event.stopImmediatePropagation();
    panning = false;
    post({ type: "dc:pan", phase: "end", x: event.clientX, y: event.clientY });
  };
  window.addEventListener("pointerup", panEnds, true);
  window.addEventListener("pointercancel", () => (panning = false), true);
  for (const type of ["mousedown", "auxclick"]) {
    window.addEventListener(type, (event) => (event as MouseEvent).button === 1 && event.preventDefault(), true);
  }

  /**
   * The wheel over an artboard is the canvas's, as it is over the empty board: Ctrl+wheel (a pinch, too,
   * which Chromium reports as Ctrl) zooms it, a plain wheel pans it. A wheel inside a frame is this
   * document's and never reaches the window around it (the person, 2026-11-11: "ctrl + mouse wheel ...
   * works over empty space in the canvas, but over an item, it wont zoom"), so it is told to the host
   * (`dc:wheel`: where, in this frame's pixels, and by how much, in pixels) and kept from this page.
   * Running (`play`), a plain wheel the design can scroll with — a list, a page taller than its artboard —
   * is the design's; edited or looked at, the canvas's, as in Figma: a body margin makes most pages a few
   * pixels taller than their artboard, and those few pixels took the wheel. Ctrl+wheel is never the design's.
   */
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && mode === "play" && scrollsWith(event.target, event.deltaX, event.deltaY)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
      post({ type: "dc:wheel", x: event.clientX, y: event.clientY, dx: event.deltaX * unit, dy: event.deltaY * unit, ctrl: event.ctrlKey });
    },
    { capture: true, passive: false },
  );

  /**
   * A drag of an element (README, "Moving an element"): drawn here as it happens — the element follows
   * the pointer by a transform, nothing else changes — and reported when the pointer lets go, with what
   * the editor needs to write it: the element's, its parent's and its siblings' boxes and source styles.
   * Registered before the catch-all below, whose `stopImmediatePropagation` would otherwise swallow it.
   */
  let press: { el: HTMLElement; x: number; y: number; moved: boolean; transform: string } | null = null;
  let swallowClick = false;
  /**
   * A drag that starts on no element — the artboard's own background: its top element, or bare page —
   * draws a selection rectangle (the person, 2026-11-08: "when the initial click doesnt land on an
   * element"). The host draws it, over the whole canvas, and picks what it holds: told WHERE the pointer
   * is, in this frame's viewport (`dc:marquee`, start | move | end), as `dc:pan` is. A press that does not
   * move is still a click, and picks the top element as before.
   */
  let marquee: { x: number; y: number; started: boolean } | null = null;
  /** The artboard's own box: an element no other element the editor can name holds. */
  const isTop = (el: HTMLElement): boolean => el.parentElement?.closest("[data-dc-id]") == null;
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (mode !== "edit" || event.button !== 0) return;
      const el = named(event.target);
      if (!el || isTop(el)) {
        marquee = { x: event.clientX, y: event.clientY, started: false };
        return;
      }
      press = { el, x: event.clientX, y: event.clientY, moved: false, transform: el.style.transform };
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (mode !== "edit" || marquee === null) return;
      if (!marquee.started) {
        if (Math.hypot(event.clientX - marquee.x, event.clientY - marquee.y) < 4) return;
        marquee.started = true;
        post({ type: "dc:marquee", phase: "start", x: marquee.x, y: marquee.y });
      }
      post({ type: "dc:marquee", phase: "move", x: event.clientX, y: event.clientY });
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (marquee === null || event.button !== 0) return;
      const { started } = marquee;
      marquee = null;
      if (!started) return;
      // The click a rectangle ends with is the rectangle's, not a pick.
      swallowClick = true;
      post({ type: "dc:marquee", phase: "end", x: event.clientX, y: event.clientY });
    },
    true,
  );
  window.addEventListener("pointercancel", () => (marquee = null), true);
  window.addEventListener(
    "pointermove",
    (event) => {
      if (mode !== "edit" || press === null) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      press.moved = true;
      press.el.style.transform = `translate(${String(dx)}px, ${String(dy)}px) ${press.transform}`.trim();
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (mode !== "edit" || press === null) return;
      const { el, x, y, moved, transform } = press;
      press = null;
      el.style.transform = transform;
      if (!moved) return;
      swallowClick = true;
      const parent = el.parentElement?.closest("[data-dc-id]") ?? null;
      const siblings = Array.from(el.parentElement?.children ?? []).filter((s): s is HTMLElement => s !== el && s.hasAttribute("data-dc-id"));
      const n = idOf(el);
      post({
        type: "dc:moved",
        id: n,
        // How far it was dragged, in the frame's CSS pixels; `rect` is where it stood before.
        dx: event.clientX - x,
        dy: event.clientY - y,
        rect: rectOf(el),
        style: fromSource(n).style,
        // The element's box parent: the nearest element the editor can name, or none (a top element).
        parent: parent ? { id: idOf(parent), rect: rectOf(parent), style: fromSource(idOf(parent)).style } : null,
        siblings: siblings.map((s) => ({ id: idOf(s), rect: rectOf(s), style: fromSource(idOf(s)).style })),
      });
    },
    true,
  );

  // A key pressed while an artboard being edited has the focus (the person pressed in it last) is the
  // editor's — Ctrl+Z, Delete, a tool's letter — so it is told to the host, which reads its keys off its
  // own window. Registered before `stop`, which keeps the design's own handlers from it. Not in play: a
  // running artboard's keys are the design's.
  for (const type of ["keydown", "keyup"] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (mode !== "edit") return;
        post({ type: "dc:key", phase: type === "keydown" ? "down" : "up", key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, repeat: event.repeat });
      },
      true,
    );
  }
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "contextmenu", "submit", "keydown", "keyup", "input", "change", "focusin"]) {
    window.addEventListener(type, stop, true);
  }
  window.addEventListener(
    "click",
    (event) => {
      if (mode !== "edit") return;
      stop(event);
      // The click a drag ends with is the drag's, not a pick.
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      const el = named(event.target);
      if (!el) return;
      const n = idOf(el);
      // `at`: where the press landed, in the artboard's own pixels — where a comment's pin is put.
      post({ type: "dc:pick", id: n, rect: rectOf(el), at: { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY }, shift: event.shiftKey, ...fromSource(n) });
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
        // `top`: the artboard's own box, where a drag draws a selection rectangle rather than moving it.
        post({ type: "dc:hover", id: el ? idOf(el) : null, rect: el ? rectOf(el) : null, top: el ? isTop(el) : false });
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
    /**
     * Every element the editor can name, for what a selection rectangle holds (`dc:elements`, answering
     * `req`): its box in this frame's viewport (`view`, where the host draws the rectangle) and on the page
     * (`rect`, as `dc:pick` reports it), its nearest named ancestor, and its source's tag, style and text.
     * An element drawn more than once (in a loop) is one template element: its boxes are joined.
     */
    measure: (req) => {
      const text = source();
      const doc = parse(text);
      const byId = new Map<number, { id: number; parent: number | null; view: { x: number; y: number; width: number; height: number }; rect: { x: number; y: number; width: number; height: number } }>();
      const join = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
      };
      for (const el of container.querySelectorAll("[data-dc-id]")) {
        const id = idOf(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const view = { x: r.left, y: r.top, width: r.width, height: r.height };
        const rect = rectOf(el);
        const parent = el.parentElement?.closest("[data-dc-id]");
        const was = byId.get(id);
        byId.set(id, was ? { ...was, view: join(was.view, view), rect: join(was.rect, rect) } : { id, parent: parent ? idOf(parent) : null, view, rect });
      }
      post({
        type: "dc:elements",
        req,
        elements: [...byId.values()].map((e) => {
          const el = doc.elements[e.id];
          return { ...e, tag: el?.tag ?? "div", style: el?.style ? decodeEntities(text.slice(el.style.start, el.style.end)) : "", text: el?.text ? decodeEntities(text.slice(el.text.start, el.text.end)) : null };
        }),
      });
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
 * Whether a wheel turned over `target` scrolls something in this page: a box under it (or the page
 * itself) that scrolls along that way and is not yet at its end that way.
 */
function scrollsWith(target: EventTarget | null, dx: number, dy: number): boolean {
  const root = document.scrollingElement ?? document.documentElement;
  const along = (overflow: string, page: boolean): boolean => (page ? overflow !== "hidden" && overflow !== "clip" : overflow === "auto" || overflow === "scroll" || overflow === "overlay");
  for (let el = target instanceof Element ? target : null; el !== null; el = el.parentElement) {
    const page = el === root;
    const style = getComputedStyle(el);
    if (dy !== 0 && along(style.overflowY, page) && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    if (dx !== 0 && along(style.overflowX, page) && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
  }
  return false;
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
