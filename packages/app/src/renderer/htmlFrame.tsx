/**
 * The static rendering of an HTML artifact — moved out of `valueView.tsx` unchanged, so the `artifact`
 * island (decision 0015, `packages/client/island/artifact.tsx`) carries this and nothing of the value
 * view's editors.
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
 * reason `valueView.tsx`'s `InteractiveArtifact` cannot be a variant of this component.
 */
export function Html({ text, style }: { text: string; style?: CSSProperties | undefined }): JSX.Element {
  // `style` is for the universal page (decision 0015), which draws this frame without `styles.css` and
  // so gives `.vv-html`'s box inline; the desktop passes none.
  return <iframe className="vv-html" sandbox="" srcDoc={text} title="Rendered HTML" style={style} />;
}
