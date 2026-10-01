import { useEffect } from "react";
import type { Tokens } from "../tokens";

/**
 * What `styles.css` and `App.tsx` do for the desktop's WINDOW rather than for any component in it, done
 * for the universal shell's page (decision 0015): the window's name, and the page-wide rules a copy cannot
 * carry inline because they select a state or a pseudo-element of every element at once. A phone has no
 * window, no keyboard focus ring and no scrollbar gutter: `windowPage.ts` does nothing there.
 */

/** `App.tsx`'s `document.title`: the window's name outside the window (the taskbar, the window switcher). */
export function useWindowTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — JaiRA`;
  }, [title]);
}

/**
 * The page's own rules, written into one `<style>` and rewritten when the look changes — on the replayed
 * page only: under `styles.css` (the `/universal` page) the stylesheet's own are already there.
 *
 *   :focus-visible            outline 2px solid --focus-ring, 1 outside the box. Without it Chromium rings
 *                             a control reached by the keyboard in its own colour (`-webkit-focus-ring-color
 *                             auto`). A copy that draws its own ring, or none, says so inline and wins.
 *   ::-webkit-scrollbar …     the ONE scrollbar, for a scroller no copy handed `scrollbarProps` (a text
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
  useEffect(() => {
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
      `:focus-visible{outline:2px solid ${ring};outline-offset:1px}` +
      `::-webkit-scrollbar{width:10px;height:10px}` +
      `::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}` +
      `::-webkit-scrollbar-thumb{min-height:32px;border:2px solid transparent;border-radius:999px;background-clip:padding-box;background-color:${ink(16)}}` +
      `:hover::-webkit-scrollbar-thumb{background-color:${ink(26)}}` +
      `::-webkit-scrollbar-thumb:hover{background-color:${ink(40)}}` +
      `::-webkit-scrollbar-thumb:active{background-color:${ink(50)}}` +
      `::-webkit-scrollbar-button{display:none}`;
    return undefined;
    // `t` is the tokens these two values were read from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayed, ring, text]);
}
const PAGE_RULES = "jaira-page";
