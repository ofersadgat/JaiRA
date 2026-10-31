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
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !artboard) return;
    const data = event.data as { type?: unknown; props?: unknown } | null;
    if (data?.type === "dc:props" && data.props !== null && typeof data.props === "object") {
      artboard.setProps(data.props as Record<string, unknown>);
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
    onReady: () => post({ type: "dc:ready", size: measure(container) }),
  });
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
