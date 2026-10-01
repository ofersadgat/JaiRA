/**
 * The static rendering of an HTML artifact, in a file of its own so the `artifact` island (decision
 * 0015: `packages/universal/src/islands/Island.tsx` on web, `packages/client/island/artifact.tsx` on a
 * phone) carries this and no editor.
 */
import type { CSSProperties, JSX } from "react";

/**
 * HTML a model produced, rendered in a sandbox.
 *
 * An `iframe` with no permissions rather than `dangerouslySetInnerHTML`: this is a privileged
 * renderer process, and the markdown path can afford an in-place sanitizer only because its parser
 * is configured to emit no HTML at all. Arbitrary HTML from a model has no such floor — `sandbox`
 * with an empty allow list means no scripts, no forms, no navigation and no same-origin access,
 * which is the only posture under which showing it is a rendering rather than an execution.
 *
 * A `srcdoc` frame also INHERITS this window's CSP, which is `script-src 'self'` — so even were the
 * sandbox opened, nothing in here could run. That is a second floor under the first, and it is the
 * reason `InteractiveArtifact` (`interactiveArtifact.tsx`) cannot be a variant of this component.
 */
export function Html({ text, style }: { text: string; style?: CSSProperties | undefined }): JSX.Element {
  // `style` is the frame's box, stated inline by the host on web (`Island.tsx`); the phone's island page
  // passes none and takes `.vv-html`'s from `styles.css`.
  return <iframe className="vv-html" sandbox="" srcDoc={text} title="Rendered HTML" style={style} />;
}
