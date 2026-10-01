/**
 * What the right-click menu for CONTENT offers — text, pictures, links — as opposed to rows.
 *
 * A right-click reaches the menu by one of two routes, and which one is not a fact the reader should
 * be able to tell:
 *
 *  - **This document.** {@link itemsForEvent} reads the ELEMENT under the pointer, which is what makes
 *    the richer cases possible — an inline `<svg>` has no URL to fetch and no bytes anywhere until
 *    something serialises it.
 *  - **An artifact frame.** A sandboxed frame with an opaque origin: no listener here hears its
 *    events. The browser process forwards what it saw (`frame:contextMenu`) and {@link itemsForFrame}
 *    builds the menu from that description instead.
 *
 * Copying an image means putting a BITMAP on the clipboard, and pasting means reading one off it;
 * neither is something a page may do on its own say-so, so the menu decides what to offer and main
 * performs it. The exceptions are the ones main cannot help with: text goes through
 * `navigator.clipboard`, and an inline SVG is serialised and rasterised here, because until this code
 * runs it is not a file.
 *
 * `PointerMenus.web.tsx` (`packages/universal/src/components/floats`) draws the menu; this is a
 * browser's module — it reads the DOM — and no phone imports it.
 */
import type { FrameContextMenu } from "@jaira/shared/browser";
import type { MenuItem } from "./menuTypes";
import { HELD_QUOTE } from "./reviewSelection";
import { invoke } from "./store";

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
      // two agree only if `field` is what is focused. Where it is not — a press on the menu took the
      // focus, or the right-click reached an element Chromium did not focus for it — it is put back
      // first. Absent on the frame route, where there is no element to name and the focused frame
      // is already the right answer.
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
/**
 * Which selection a menu is about: the live one, or the one a surface is HOLDING for it.
 *
 * Its own function because it is the only part of {@link itemsForEvent} a test in this repo can
 * reach — the suite runs on `environment: "node"`, so there is no `Element` to hand the caller and
 * no `window.getSelection()` to answer it. The same reason {@link itemsForFrame} is exported.
 *
 * `live` is the browser's answer and wins whenever it has one: a fresh drag inside a surface that
 * happens to be holding an older passage is about the words under the pointer.
 *
 * `held` is the fallback, and it is not a nicety. A textarea owns its own selection, so the moment a
 * comment composer takes the focus the document's selection collapses — while the passage stays
 * marked on screen, because the artifact paints it. Right-clicking words that are visibly selected
 * then produced no menu at all, which reads as the app being broken rather than as a subtlety about
 * where the caret went.
 *
 * `fromField` is what keeps the two apart where it matters. The composer's textarea sits INSIDE the
 * pane holding the quote, so a right-click in an empty comment box would otherwise offer to copy the
 * passage the box is about, and to cut it out of a field it is not in.
 */
export function selectionForMenu(live: string, held: string | null): { text: string; fromField: string } {
  const now = live.trim();
  if (now !== "") return { text: now, fromField: now };
  return { text: (held ?? "").trim(), fromField: "" };
}

export function itemsForEvent(event: MouseEvent): MenuItem[] {
  const target = event.target;
  if (!(target instanceof Element)) return [];
  // See {@link HELD_QUOTE} for why the held passage is an attribute rather than a shared variable:
  // this function asks every other question it asks by walking up from the element it was given.
  const { text: selection, fromField } = selectionForMenu(
    window.getSelection()?.toString() ?? "",
    target.closest(`[${HELD_QUOTE}]`)?.getAttribute(HELD_QUOTE) ?? null,
  );

  const field = target.closest("input, textarea, [contenteditable='true']");
  if (field !== null) {
    // Asked of the DOM rather than of Chromium, because this route HAS the element: a read-only or
    // disabled field can be copied from and not written to, and the flags should say so.
    const input = field as HTMLInputElement & HTMLTextAreaElement;
    const writable = input.readOnly !== true && input.disabled !== true;
    /**
     * A field's OWN selection, which is not the document's.
     *
     * `input` and `textarea` selections live outside the document tree, so
     * `window.getSelection().toString()` answers `""` however much of a box is highlighted — which
     * greyed out Cut and Copy in every text box in the app, on exactly the text somebody had just
     * dragged over in order to copy it. `selectionStart`/`selectionEnd` is where the answer actually
     * is. A `contenteditable` has no such pair and IS in the document, so it falls back to the
     * document's own — see {@link selectionForMenu} for why a held quote is never lent to a field.
     */
    const inField =
      typeof input.selectionStart === "number" && typeof input.selectionEnd === "number"
        ? input.selectionEnd > input.selectionStart
        : fromField !== "";
    return editItems(
      { canCut: writable && inField, canCopy: inField, canPaste: writable, canSelectAll: true },
      input,
    );
  }

  const image = target.closest("img");
  if (image !== null) return imageItems(image.currentSrc !== "" ? image.currentSrc : image.src, event.clientX, event.clientY);

  /*
   * `aria-hidden` is the app's own word for "this is a glyph beside a word, not a picture" — see
   * `Svg.web.tsx`, which sets it on every glyph the app draws for exactly that reason. Offering to
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
