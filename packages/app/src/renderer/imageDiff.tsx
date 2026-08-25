/**
 * Two versions of a picture, compared.
 *
 * A text diff answers "which characters moved"; there is no equivalent question for an image, so
 * the only honest thing a reviewer can do is look at both. Two ways of looking, because they answer
 * different questions:
 *
 *  - **Side by side** — what each version IS. Right for a redesign, where the two are meant to
 *    differ everywhere and the point is to judge the new one.
 *  - **Overlay** — WHERE they differ. The two are stacked and the top one's opacity is on a slider,
 *    so dragging it makes anything that moved shimmer and anything identical sit still. That is the
 *    only way to catch a four-pixel shift, which side by side hides completely.
 *
 * ## What this needs, and what a changeset currently gives it
 *
 * Both bytes. A changeset produced by the worktree differ marks an image `unshowable: "binary"` and
 * carries no content, so this renders nothing for those — correctly, because there is nothing to
 * render. It is live wherever the producer does supply the bytes (a `show_artifact` result, an
 * artifact envelope, a data URI), and it is here rather than waiting for that because the reviewer
 * having no answer for pictures is the gap, not the missing plumbing.
 */
import { useState, type JSX } from "react";

export type ImageLayout = "overlay" | "split";

export function ImageDiff({
  before,
  after,
  layout,
  onLayout,
}: {
  /** Anything an `<img>` accepts. Absent ⇒ the change created or deleted the file. */
  before?: string | undefined;
  after?: string | undefined;
  layout: ImageLayout;
  onLayout: (next: ImageLayout) => void;
}): JSX.Element {
  const [mix, setMix] = useState(0.5);
  const both = before !== undefined && after !== undefined;

  // Only one side exists: a create or a delete. There is nothing to compare, so nothing to toggle.
  if (!both) {
    const only = after ?? before;
    if (only === undefined) return <p className="empty">Neither version of this image is available to show.</p>;
    return (
      <figure className="img-diff-one">
        <img src={only} alt={after !== undefined ? "the new image" : "the removed image"} />
        <figcaption>{after !== undefined ? "added" : "removed"}</figcaption>
      </figure>
    );
  }

  return (
    <div className="img-diff">
      <div className="vv-diff-bar">
        <span className="vv-toggle" role="group" aria-label="How to compare the images">
          <button
            type="button"
            className={layout === "overlay" ? "on" : undefined}
            aria-pressed={layout === "overlay"}
            title="Stacked, with the new one fading in — shows WHERE they differ"
            onClick={() => onLayout("overlay")}
          >
            Overlay
          </button>
          <button
            type="button"
            className={layout === "split" ? "on" : undefined}
            aria-pressed={layout === "split"}
            title="Two columns — shows what each version is"
            onClick={() => onLayout("split")}
          >
            Side by side
          </button>
        </span>
        {layout === "overlay" ? (
          <label className="img-diff-mix">
            <span className="sub">before</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={mix}
              aria-label="Fade between the two versions"
              onChange={(e) => setMix(Number(e.target.value))}
            />
            <span className="sub">after</span>
          </label>
        ) : null}
      </div>

      {layout === "split" ? (
        <div className="img-diff-split">
          <figure>
            <img src={before} alt="before" />
            <figcaption>before</figcaption>
          </figure>
          <figure>
            <img src={after} alt="after" />
            <figcaption>after</figcaption>
          </figure>
        </div>
      ) : (
        // The two are absolutely stacked so they share one box; the checkerboard behind them is what
        // makes a transparency change visible rather than reading as a colour change.
        <div className="img-diff-stack">
          <img src={before} alt="before" />
          <img src={after} alt="after" style={{ opacity: mix }} />
        </div>
      )}
    </div>
  );
}
