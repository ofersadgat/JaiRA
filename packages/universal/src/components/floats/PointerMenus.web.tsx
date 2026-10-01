import { useCallback, useEffect, useState, type JSX } from "react";
import type { PushMessage } from "@jaira/shared/browser";
import { itemsForEvent, itemsForFrame } from "@jaira/ui/pointerMenuModel";
import { subscribe } from "@jaira/ui/store";
import { ContextMenu, type MenuAt } from "../Menu";

/**
 * `pointerMenu.tsx`'s `PointerMenus`, universal on web (decision 0015): the right-click menu for CONTENT —
 * a selection, a link, a picture, a box being typed in — as opposed to rows, drawn as the app's own menu
 * (`ContextMenu`). What it offers is the desktop's own decision (`itemsForEvent` over the element clicked,
 * `itemsForFrame` over what main forwards from an artifact's sandboxed frame), and the verbs are its.
 *
 * A row with a menu of its own claims the click first (`preventDefault`, or a card's `stopPropagation`),
 * and this listener, on the window, stands down; otherwise it claims it too, since the window has no
 * native menu to fall back on. A click inside a sandboxed frame never reaches here, so the window losing
 * focus closes the menu instead.
 */
export function PointerMenus(): JSX.Element | null {
  const [anchor, setAnchor] = useState<MenuAt | null>(null);
  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    const onMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
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
        const items = itemsForFrame(message.menu);
        setAnchor(items.length === 0 ? null : { x: message.menu.x, y: message.menu.y, items });
      }),
    [],
  );

  return anchor === null ? null : <ContextMenu anchor={anchor} onClose={close} />;
}
