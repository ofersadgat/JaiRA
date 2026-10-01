/**
 * The frame an interactive artifact runs in, in a file of its own so the `artifact` island on web
 * (decision 0015, `packages/universal/src/islands/Island.tsx`) draws this frame and carries no editor.
 * What grants it an address is `artifactFrame.ts`.
 */
import { useEffect, useRef, type CSSProperties, type JSX } from "react";

/**
 * An artifact that RUNS — the interactive case, and the only thing in this app that executes code a
 * model wrote.
 *
 * Loaded from `jaira-artifact:` rather than `srcdoc`, because a `srcdoc` document inherits this
 * window's CSP and would have every inline script refused. The scheme's handler serves the bytes with
 * a policy of its own: inline script permitted, and network, frames, forms and base-uri all denied.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`. The two together are not additive — a frame
 * granted both can reach its own `sandbox` attribute and remove it — so this pair is the whole
 * posture, and the missing flag matters more than the present one. The frame therefore has an opaque
 * origin, which is what keeps it away from this window's storage and DOM.
 *
 * ## Why the bridge fills the composer instead of sending
 *
 * A page a model wrote posting straight into a live run is closer to `bash` than to rendering: it
 * would let generated markup drive the conversation that generated it. So a message lands in the
 * composer, where a person reads it and presses send. That keeps the useful half — a button in a
 * mockup that says what it would ask — without the half nobody asked for.
 *
 * `event.source` is what authenticates it, NOT `event.origin`: an opaque origin serialises to the
 * string `"null"`, which every other sandboxed frame also reports, so matching on it would accept a
 * message from any of them. Identity here is the window object itself.
 */
export function InteractiveArtifact({ url, onPrompt, style }: { url: string; onPrompt?: ((text: string) => void) | undefined; style?: CSSProperties | undefined }): JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (onPrompt === undefined) return;
    const onMessage = (event: MessageEvent): void => {
      // The window that sent it, not the origin it claims — see the component note.
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; text?: unknown } | null;
      if (data === null || typeof data !== "object" || data.type !== "prompt") return;
      if (typeof data.text !== "string" || data.text.trim() === "") return;
      // Bounded: this is a message from a page that may have been generated wrong, and a composer is
      // not the place to discover that something posted a megabyte into it.
      onPrompt(data.text.slice(0, 4000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPrompt]);

  // `style`: the frame's box, stated inline by the host (`Island.tsx`), as `Html`'s is.
  return <iframe className="vv-html" ref={frame} sandbox="allow-scripts" src={url} title="Interactive artifact" style={style} />;
}
