/**
 * The right-click menu for CONTENT — text, pictures, links — as opposed to rows.
 *
 * The app already had context menus, and every one of them was about a thing it had drawn: a file in
 * the tree, a card on the board, a conversation in the list. Right-clicking anything else did
 * nothing at all, because the window has no native menu either (`main/index.ts` nulls it), so the
 * one gesture everybody makes on a selected paragraph or a picture had no answer anywhere in the
 * app. This is that answer, and it is deliberately the SAME menu: `ContextMenu` from `menu.tsx`,
 * with the app's own type and spacing, rather than a second menu system in OS chrome.
 *
 * ## Two sources, one menu
 *
 * A right-click reaches here by one of two routes, and which one is not a fact the reader should be
 * able to tell:
 *
 *  - **This document.** An ordinary `contextmenu` listener on the window. It sees the ELEMENT, which
 *    is what makes the richer cases possible — an inline `<svg>` has no URL to fetch and no bytes
 *    anywhere until something serialises it.
 *  - **An artifact frame.** A sandboxed frame with an opaque origin: no listener here hears its
 *    events, and reaching into it is precisely what the sandbox exists to prevent. The browser
 *    process forwards what it saw (`frame:contextMenu`) and the menu is built from that description
 *    instead. Fewer cases are possible — there is no element to ask — and the ones that are behave
 *    identically.
 *
 * ## Why the verbs go back to main
 *
 * Copying an image means putting a BITMAP on the clipboard, and pasting means reading one off it;
 * neither is something a page may do on its own say-so, and both are things Chromium already knows
 * how to do for the frame that was clicked. So the menu decides what to offer and main performs it.
 * The exceptions are the ones main cannot help with: text goes through `navigator.clipboard`, and an
 * inline SVG is serialised and rasterised here, because until this code runs it is not a file.
 *
 * ## Yielding to the menus that were already here
 *
 * A row that has its own menu calls `preventDefault`, and this listener is on the window — so it
 * runs after React's, sees `defaultPrevented`, and stands down. That is the whole coordination
 * mechanism: a component that knows what was clicked on always wins over the one that is guessing
 * from the DOM.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { FrameContextMenu, PushMessage } from "@jaira/shared/browser";
import { ContextMenu, type MenuAnchor, type MenuItem } from "./menu";
import { invoke, subscribe } from "./store";

/** Put text on the clipboard, quietly. A refused clipboard is not worth a toast over a copy. */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Save bytes through the OS dialog. `data` is base64 — see `shell:saveFile`. */
function save(name: string, data: string): void {
  void invoke("shell:saveFile", { name, data }).catch(() => undefined);
}

/** Bytes as base64, which is what `shell:saveFile` takes. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * An `<svg>` in this document, as a standalone file.
 *
 * Three things have to be added, and each is something the element was getting from the page rather
 * than carrying itself. The namespace, because a fragment lifted out of an HTML document has no
 * `xmlns` and is not a valid SVG file without one. Explicit `width` and `height`, because these are
 * sized by CSS and a file with only a `viewBox` has no intrinsic size for anything to draw it at.
 * And the resolved `color`, because every glyph in this app is stroked with `currentColor` — a
 * serialised copy without it is a black-on-black picture of nothing.
 */
function svgFileOf(svg: SVGSVGElement): { text: string; width: number; height: number } {
  const box = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.style.color = window.getComputedStyle(svg).color;
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

/**
 * The same SVG as a PNG, at twice its drawn size.
 *
 * Twice, because the thing being copied is a vector and the place it is going — a clipboard, a chat
 * message, a document — is very unlikely to be the size it happened to be rendered at here.
 * Rasterising at the CSS size produces something visibly worse than what was on screen, which is not
 * what "copy this picture" should mean.
 *
 * Returns null rather than throwing on a picture that will not draw: `Image` refuses malformed
 * markup, and a canvas holding foreign content refuses to export. Both are ordinary outcomes for
 * content this app did not write, and both should cost the one menu item and nothing else.
 */
async function pngOf(svg: SVGSVGElement): Promise<Blob | null> {
  const file = svgFileOf(svg);
  const scale = 2;
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the picture would not load"));
      image.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = file.width * scale;
    canvas.height = file.height * scale;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

/**
 * The edit verbs, with Chromium's own answer for whether each would do anything.
 *
 * Shown DISABLED rather than omitted when they would not: this is the one menu in the app whose
 * shape people know before they open it, and a Paste that moves position depending on what is on
 * the clipboard is a menu you have to read every time.
 */
function editItems(flags: FrameContextMenu["editFlags"], field?: HTMLElement): MenuItem[] {
  const run =
    (verb: "cut" | "copy" | "paste" | "selectAll") => () => {
      // The verb acts on whatever has focus, and the flags above were decided about `field` — so the
      // two agree only if `field` is what is focused. `ContextMenu` no longer takes focus away from
      // it, which is what makes that true in the ordinary case; this covers the rest, where the
      // right-click reached an element Chromium did not focus for it. Absent on the frame route,
      // where there is no element to name and the focused frame is already the right answer.
      if (field !== undefined && document.activeElement !== field) field.focus({ preventScroll: true });
      void invoke("shell:edit", { verb }).catch(() => undefined);
    };
  return [
    { label: "Cut", disabled: !flags.canCut, onSelect: run("cut") },
    { label: "Copy", disabled: !flags.canCopy, onSelect: run("copy") },
    { label: "Paste", disabled: !flags.canPaste, onSelect: run("paste") },
    { label: "Select all", separator: true, disabled: !flags.canSelectAll, onSelect: run("selectAll") },
  ];
}

/** What an image offers, wherever it lives: the picture, the file, and the address. */
function imageItems(src: string, x: number, y: number): MenuItem[] {
  const items: MenuItem[] = [
    { label: "Copy image", onSelect: () => void invoke("shell:copyImageAt", { x, y }).catch(() => undefined) },
  ];
  if (src === "") return items;
  items.push({
    label: "Save image as…",
    separator: true,
    onSelect: () => void invoke("shell:download", { url: src }).catch(() => undefined),
  });
  // A `data:` source IS the picture rather than a place it lives, so there is no address anyone
  // could paste anywhere useful — and pasting sixty kilobytes of base64 into a chat is a menu item
  // doing harm.
  if (!src.startsWith("data:")) items.push({ label: "Copy image address", onSelect: () => copyText(src) });
  return items;
}

/** What an inline `<svg>` offers. It is not a file yet, which is why all four of these do work. */
function svgItems(svg: SVGSVGElement): MenuItem[] {
  return [
    {
      label: "Copy image",
      onSelect: () => {
        void (async () => {
          const png = await pngOf(svg);
          if (png === null) return;
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          } catch {
            // A clipboard that refuses a bitmap is not worth saying anything about: the markup is
            // one item down, and that route is always available.
          }
        })();
      },
    },
    { label: "Copy as SVG", onSelect: () => copyText(svgFileOf(svg).text) },
    {
      label: "Download SVG…",
      separator: true,
      onSelect: () => save("image.svg", base64Of(new TextEncoder().encode(svgFileOf(svg).text))),
    },
    {
      label: "Download PNG…",
      onSelect: () => {
        void (async () => {
          const png = await pngOf(svg);
          if (png !== null) save("image.png", base64Of(new Uint8Array(await png.arrayBuffer())));
        })();
      },
    },
  ];
}

/**
 * What this document's own right-click offers, decided from the element under it.
 *
 * Ordered most specific first, and the first four cases are exclusive: a picture inside a link is a
 * picture. An empty result means there is nothing worth showing — which is a real answer, and better
 * than a menu whose only entry is a greyed-out verb.
 */
function itemsForEvent(event: MouseEvent): MenuItem[] {
  const target = event.target;
  if (!(target instanceof Element)) return [];
  const selection = (window.getSelection()?.toString() ?? "").trim();

  const field = target.closest("input, textarea, [contenteditable='true']");
  if (field !== null) {
    // Asked of the DOM rather than of Chromium, because this route HAS the element: a read-only or
    // disabled field can be copied from and not written to, and the flags should say so.
    const input = field as HTMLInputElement & HTMLTextAreaElement;
    const writable = input.readOnly !== true && input.disabled !== true;
    return editItems(
      {
        canCut: writable && selection !== "",
        canCopy: selection !== "",
        canPaste: writable,
        canSelectAll: true,
      },
      input,
    );
  }

  const image = target.closest("img");
  if (image !== null) return imageItems(image.currentSrc !== "" ? image.currentSrc : image.src, event.clientX, event.clientY);

  /*
   * `aria-hidden` is the app's own word for "this is a glyph beside a word, not a picture" — see
   * `icons.tsx`, where it is set on every icon in the app for exactly that reason. Offering to
   * download a 14px chevron as a PNG is the kind of menu item that makes people stop opening menus,
   * and this marker is what separates one from a diagram somebody would actually want.
   */
  const svg = target.closest("svg");
  if (svg !== null && svg.getAttribute("aria-hidden") !== "true") return svgItems(svg as SVGSVGElement);

  const items: MenuItem[] = [];
  if (selection !== "") items.push({ label: "Copy", onSelect: () => copyText(selection) });
  const link = target.closest("a[href]");
  if (link !== null) {
    items.push({
      label: "Copy link",
      separator: items.length > 0,
      onSelect: () => copyText((link as HTMLAnchorElement).href),
    });
  }
  return items;
}

/**
 * The same decision for a frame, made from a description instead of an element.
 *
 * Exported for its own sake: this is the branch a test can actually reach — no DOM, no element, just
 * the description Chromium forwarded — and it is the branch that decides what right-clicking inside
 * a model-authored page offers.
 */
export function itemsForFrame(menu: FrameContextMenu): MenuItem[] {
  if (menu.isEditable) return editItems(menu.editFlags);
  if (menu.mediaType === "image") return imageItems(menu.srcURL, menu.x, menu.y);
  const items: MenuItem[] = [];
  if (menu.selectionText.trim() !== "") {
    items.push({ label: "Copy", onSelect: () => copyText(menu.selectionText) });
  }
  if (menu.linkURL !== "") {
    items.push({ label: "Copy link", separator: items.length > 0, onSelect: () => copyText(menu.linkURL) });
  }
  // Video and audio have no bitmap to put on a clipboard, but they are still a file somewhere.
  if (menu.srcURL !== "" && (menu.mediaType === "video" || menu.mediaType === "audio")) {
    items.push({
      label: `Save ${menu.mediaType} as…`,
      separator: items.length > 0,
      onSelect: () => void invoke("shell:download", { url: menu.srcURL }).catch(() => undefined),
    });
  }
  return items;
}

/**
 * Mounted once, by the shell. Listens on both routes and draws whichever fired last.
 *
 * Nothing here is conditional on a view: a right-click means the same thing in the Files tree as in
 * a conversation, and a menu that existed in some rooms and not others is a menu people stop
 * reaching for.
 */
export function PointerMenus(): JSX.Element | null {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    const onMenu = (event: MouseEvent): void => {
      // A row with its own menu has already claimed this click — see the module header.
      if (event.defaultPrevented) return;
      // Claimed whether or not anything is offered: this window has no native menu to fall back to,
      // so leaving it uncancelled would put the browser process's forwarded copy on screen a moment
      // later, for the document we have just decided had nothing to show.
      event.preventDefault();
      const items = itemsForEvent(event);
      // The element right-clicked, so a scroll somewhere else in the window does not take the menu
      // down with it — see `MenuPoint`.
      const origin = event.target instanceof Element ? { origin: event.target } : {};
      setAnchor(items.length === 0 ? null : { x: event.clientX, y: event.clientY, ...origin, items });
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);

  /*
   * The dismissal `ContextMenu` cannot do for itself, for the one menu that needs it.
   *
   * It closes on an outside mousedown, and a click inside a sandboxed frame is not one: the event
   * never leaves that document. So a menu opened over an artifact would hang there while somebody
   * carried on clicking inside the page underneath it. Focus does move, and that is the signal.
   */
  useEffect(() => {
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [close]);

  useEffect(
    () =>
      subscribe((message: PushMessage) => {
        if (message.type !== "frame:contextMenu") return;
        const items = itemsForFrame(message.menu);
        setAnchor(items.length === 0 ? null : { x: message.menu.x, y: message.menu.y, items });
      }),
    [],
  );

  return anchor === null ? null : <ContextMenu anchor={anchor} onClose={close} />;
}
