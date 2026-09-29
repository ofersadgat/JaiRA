import { Html } from "@jaira/ui/htmlFrame";
import { mountIsland } from "./host";

/**
 * The artifact island (decision 0015): an HTML or SVG artifact drawn as the page it is — web content by
 * nature, so on a phone it stays in a WebView, as the desktop draws it in a frame (`valueView.tsx`'s
 * `Html`: sandboxed, nothing in it runs). Sized to its content.
 */
mountIsland({
  drawn: "#island iframe",
  draw: (p) => (
    <div className="vv-body">
      <Html text={String(p["text"] ?? "")} />
    </div>
  ),
});
