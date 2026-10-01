import { useEffect, useLayoutEffect } from "react";
import type { Tokens } from "../tokens";

/**
 * What the shell does for the WINDOW rather than for any component in it, on web: the window's name, and
 * the page-wide rules a component cannot carry inline because they select a state or a pseudo-element of
 * every element at once. A phone has no window, no keyboard focus ring and no scrollbar gutter:
 * `windowPage.ts` does nothing there.
 */

/** `document.title`: the window's name outside the window (the taskbar, the window switcher). */
export function useWindowTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — JaiRA`;
  }, [title]);
}

/**
 * The page's own rules, written into one `<style>` and rewritten when the look changes. Only where the
 * tokens are the replayed cascade (`t.replayed`), which they are wherever the shell is drawn (`Replayed`
 * around it, in the client's `index.web.tsx`): tokens that are not would be a page that brings a
 * stylesheet with these rules in it, and there is no such page.
 *
 *   body                      the window's ground, --bg, on the page's own canvas and not on a box of the
 *                             shell's, because which of the two holds it decides how text is smoothed.
 *                             Chromium draws text subpixel only in a layer it knows to be opaque, and when
 *                             something is painted under the whole page (Monaco's hidden input is,
 *                             `z-index: -10`) everything else goes in a layer over it — one that does not
 *                             hold the canvas's ground, so the sidebar and inbox strip are greyscale
 *                             there, as the reference pictures hold them (`pair.mts`). A shell that
 *                             painted the ground itself kept that layer opaque, and its text subpixel.
 *   :focus-visible            outline 2px solid --focus-ring, 1 outside the box. Without it Chromium rings
 *                             a control reached by the keyboard in its own colour (`-webkit-focus-ring-color
 *                             auto`). A component that draws its own ring, or none, says so inline and wins.
 *   ::-webkit-scrollbar …     the ONE scrollbar, for a scroller nothing handed `scrollbarProps` (a text
 *                             box, a scroller added later): the 10px gutter and the rounded thumb drawn
 *                             from the root's --text, where Chromium's own is a 17px slab that is light in
 *                             every look. A scroller with `data-scrollbar` keeps its own, which is the same
 *                             rule in the --text of where it stands (the sidebar's): an attribute selector
 *                             beats these.
 */
export function usePageRules(t: Tokens): void {
  const replayed = t.replayed;
  const ring = replayed ? String(t.v("focus-ring")) : "";
  const text = replayed ? String(t.v("text")) : "";
  const ground = replayed ? String(t.v("bg")) : "";
  // Before the first paint: the shell draws no ground of its own on this page (`pageGround`).
  useLayoutEffect(() => {
    if (!replayed) return undefined;
    const ink = (pct: number): string => t.mix(text, pct, "transparent");
    let sheet = document.getElementById(PAGE_RULES) as HTMLStyleElement | null;
    if (sheet === null) {
      sheet = document.createElement("style");
      sheet.id = PAGE_RULES;
      // Before the scrollbar rules a scroller points itself at (`jaira-scrollbars`), whatever the order
      // they were asked for in: equal pseudo-elements would otherwise go to whichever came later.
      document.head.insertBefore(sheet, document.head.firstChild);
    }
    sheet.textContent =
      `body{background:${ground}}` +
      `:focus-visible{outline:2px solid ${ring};outline-offset:1px}` +
      `::-webkit-scrollbar{width:10px;height:10px}` +
      `::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}` +
      `::-webkit-scrollbar-thumb{min-height:32px;border:2px solid transparent;border-radius:999px;background-clip:padding-box;background-color:${ink(16)}}` +
      `:hover::-webkit-scrollbar-thumb{background-color:${ink(26)}}` +
      `::-webkit-scrollbar-thumb:hover{background-color:${ink(40)}}` +
      `::-webkit-scrollbar-thumb:active{background-color:${ink(50)}}` +
      `::-webkit-scrollbar-button{display:none}`;
    return undefined;
    // `t` is the tokens these values were read from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayed, ring, text, ground]);
}

/** Whether the page's own canvas carries the window's ground ({@link usePageRules}), so the shell paints none. */
export const pageGround = (t: Tokens): boolean => t.replayed;
const PAGE_RULES = "jaira-page";
