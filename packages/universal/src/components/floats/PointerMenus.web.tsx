import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { PushMessage } from "@jaira/shared/browser";
import { itemsForEvent, itemsForFrame } from "@jaira/ui/pointerMenuModel";
import { browserForwardsMenus, subscribe } from "@jaira/ui/store";
import { ContextMenu, type MenuAt } from "../Menu";

/**
 * The right-click menu for CONTENT on web — a selection, a link, a picture, a box being typed in — as
 * opposed to rows, drawn as the app's own menu (`ContextMenu`). What it offers is `pointerMenuModel.ts`'s
 * decision (`itemsForEvent` over the element clicked, `itemsForFrame` over what main forwards from an
 * artifact's sandboxed frame), and the verbs are its.
 *
 * A row with a menu of its own claims the click first (`preventDefault`, or a card's `stopPropagation`),
 * and this listener, on the window, stands down; otherwise it claims it too, since the window has no
 * native menu to fall back on. A click inside a sandboxed frame never reaches here, so the window losing
 * focus closes the menu instead.
 */
export function PointerMenus(): JSX.Element | null {
  const [anchor, setAnchor] = useState<MenuAt | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  /**
   * A field right-clicked in this window and let through to Chromium, waiting for main to forward
   * what it saw — the misspelled word under the pointer and the suggestions for it, which the DOM
   * does not carry. Only in the desktop window (`browserForwardsMenus`): anywhere else nothing would
   * forward it, and the browser's own menu would open instead of this one.
   */
  const pendingField = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const field = target instanceof Element ? target.closest<HTMLElement>("input, textarea, [contenteditable='true']") : null;
      if (field !== null && browserForwardsMenus()) {
        // Not cancelled: Chromium raises its own event only for a click nobody cancelled, and the menu
        // is drawn from what it forwards (below). Electron shows no menu of its own meanwhile.
        pendingField.current = field;
        setAnchor(null);
        return;
      }
      event.preventDefault();
      const items = itemsForEvent(event);
      setAnchor(items.length === 0 ? null : { x: event.clientX, y: event.clientY, items });
    };
    window.addEventListener("contextmenu", onMenu);
    return () => window.removeEventListener("contextmenu", onMenu);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [close]);

  useEffect(
    () =>
      subscribe((message: PushMessage) => {
        if (message.type !== "frame:contextMenu") return;
        let field: HTMLElement | undefined;
        if (message.menu.mainFrame) {
          // Only a field this listener let through is answered: any other main-frame right-click
          // reached Chromium because a row claimed it, and that row is drawing its own menu.
          field = pendingField.current ?? undefined;
          pendingField.current = null;
          if (field === undefined) return;
        }
        const items = itemsForFrame(message.menu, field);
        setAnchor(items.length === 0 ? null : { x: message.menu.x, y: message.menu.y, items });
      }),
    [],
  );

  return anchor === null ? null : <ContextMenu anchor={anchor} onClose={close} />;
}
