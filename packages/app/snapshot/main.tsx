/**
 * The specimen page the harness photographs.
 *
 * One theme per load (`?theme=dark`), because the app's palettes hang off `:root[data-theme]` and a
 * page showing both at once would have to scope them to a subtree — which is a stylesheet this app
 * does not have, and a snapshot of it would be a snapshot of the harness.
 *
 * `data-ready` is what the harness waits for. Photographing before `document.fonts.ready` catches
 * the fallback face mid-swap, which is exactly the difference the comparison is looking for.
 *
 * ## A specimen that throws must SAY so
 *
 * `data-ready` used to be set from `document.fonts.ready` alone, which resolves whether or not React
 * ever committed anything. One specimen throwing during render therefore produced a page with no
 * `[data-shot]` elements at all, a harness that waited successfully, and a run that logged "done"
 * and wrote nothing. So the flag is now raised from an EFFECT — effects only run after a commit —
 * and every specimen renders inside a boundary that draws its own failure into the frame, so the
 * one that broke is photographed as a red panel naming itself rather than deleting the whole page.
 */
import { Component, Fragment, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { JSX } from "react";
import "../src/renderer/styles.css";
import { SPECIMENS } from "./specimens";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset["theme"] = theme;
document.body.style.background = "var(--bg)";
document.body.style.margin = "0";

/** What broke, in the order it broke, for the harness to read back out of the page. */
const FAILURES: string[] = [];

/**
 * One specimen's blast radius.
 *
 * Per specimen rather than one around the page, because the point of the page is the OTHER
 * specimens: a single broken one should cost its own frame and nothing else. The message is drawn
 * rather than only logged so that the frame the harness photographs is itself the report.
 */
class Boundary extends Component<{ id: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = (info.componentStack ?? "").trim().split("\n").slice(0, 8).join("\n");
    FAILURES.push(`${this.props.id}: ${error.message}\n${where}`);
    console.error(`specimen "${this.props.id}" threw during render`, error, where);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div style={{ padding: 12, overflow: "auto", font: "12px/1.45 ui-monospace, monospace", color: "#b00020" }}>
        <strong>{this.props.id} threw</strong>
        <div style={{ marginTop: 6 }}>{error.message}</div>
      </div>
    );
  }
}

/**
 * The flag, raised from a committed tree.
 *
 * The effect runs only if React got this far, so a page that failed to render at all never sets it
 * and the harness reports a timeout instead of an empty success.
 */
function Ready(): null {
  useEffect(() => {
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        if (FAILURES.length > 0) document.documentElement.dataset["failed"] = String(FAILURES.length);
        document.documentElement.dataset["ready"] = "1";
      });
    });
  }, []);
  return null;
}

/**
 * Mount a specimen AGAIN, from nothing — what a first render actually is.
 *
 * Every frame this harness takes is taken after the page has settled: `data-ready` waits for fonts
 * and a committed tree, and each shot waits another 120ms after scrolling. That is the right default
 * — a photograph of a half-drawn page is a photograph of a race — but it means a defect that only
 * exists on the FIRST render is one the harness structurally cannot see. It draws the recovered
 * state and reports success.
 *
 * This is the way in. Bumping the key throws the subtree away and builds it again, so anything that
 * happens once per mount happens again on demand: a widget whose DOM is filled asynchronously, an
 * editor measuring a container that has no size yet, a lazily imported chunk arriving after the
 * layout that needed it. A `run` step can then remount and measure in the same task, which is the
 * only vantage point from which "wrong at first, right a frame later" is visible at all.
 */
const REMOUNTS = new Map<string, () => void>();

declare global {
  interface Window {
    /** Remount one specimen by id. Returns false if nothing has that id. */
    remount(id: string): boolean;
  }
}

window.remount = (id: string): boolean => {
  const again = REMOUNTS.get(id);
  if (again === undefined) return false;
  again();
  return true;
};

/** One specimen's subtree, thrown away and rebuilt when the harness asks. */
function Remountable({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    REMOUNTS.set(id, () => setNonce((n) => n + 1));
    return () => {
      REMOUNTS.delete(id);
    };
  }, [id]);
  return <Boundary id={id}>{<Fragment key={nonce}>{children}</Fragment>}</Boundary>;
}

/** One framed specimen. The frame is the only markup here the app does not own. */
function Framed(): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, padding: 24, alignItems: "flex-start" }}>
      {SPECIMENS.map((s) => (
        <figure key={s.id} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <figcaption className="app-secondary">{s.figure}</figcaption>
          <div
            data-shot={s.id}
            style={{
              width: s.width,
              height: s.height,
              overflow: "hidden",
              background: "var(--bg)",
              border: "1px solid var(--line)",
              borderRadius: 11,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Remountable id={s.id}>{s.node}</Remountable>
          </div>
        </figure>
      ))}
      <Ready />
    </div>
  );
}

/** What the harness reads to find out whether the page it is photographing is whole. */
declare global {
  var __specimenFailures: string[];
}
globalThis.__specimenFailures = FAILURES;

createRoot(document.getElementById("root")!).render(<Framed />);
