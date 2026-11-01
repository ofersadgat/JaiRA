import { Html } from "@jaira/ui/htmlFrame";
import { InteractiveArtifact } from "@jaira/ui/interactiveArtifact";
import { mountIsland } from "./host";

/**
 * The artifact island (decision 0015): an HTML or SVG artifact drawn as the page it is - web content by
 * nature, so on a phone it stays in a WebView, as on web it is drawn in a frame. Sized to its content.
 *
 * Handed a `url` - a grant at the engine's HTTP route, which the phone's engine bridge put where the
 * desktop's `jaira-artifact:` address was (decision 0020 §4) - it RUNS the page, as the web island does,
 * its prompts and downloads events of this island. Without one, it draws the text (`htmlFrame.tsx`'s
 * `Html`: sandboxed, nothing in it runs).
 */
mountIsland({
  drawn: "#island iframe",
  draw: (p, event) => (
    <div className="vv-body">
      {typeof p["url"] === "string" ? (
        <InteractiveArtifact
          url={p["url"]}
          onPrompt={event("prompt")}
          {...(p["downloads"] === true ? { onDownload: event("download") } : {})}
          style={p["style"] as never}
          published={p["published"] === true}
        />
      ) : (
        <Html text={String(p["text"] ?? "")} />
      )}
    </div>
  ),
});
