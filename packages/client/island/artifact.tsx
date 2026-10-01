import { Html } from "@jaira/ui/htmlFrame";
import { mountIsland } from "./host";

/**
 * The artifact island (decision 0015): an HTML or SVG artifact drawn as the page it is — web content by
 * nature, so on a phone it stays in a WebView, as the desktop draws it in a frame (`valueView.tsx`'s
 * `Html`: sandboxed, nothing in it runs). Sized to its content.
 *
 * Only ever static here. An interactive artifact runs on the desktop from a `jaira-artifact:` address the
 * window's own protocol serves, which a phone's WebView cannot load; the universal value view asks for no
 * grant on a phone, so this page is never handed the `url` the web island runs (`islands/Island.tsx`).
 */
mountIsland({
  drawn: "#island iframe",
  draw: (p) => (
    <div className="vv-body">
      <Html text={String(p["text"] ?? "")} />
    </div>
  ),
});
