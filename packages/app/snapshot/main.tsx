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
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
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
            <Boundary id={s.id}>{s.node}</Boundary>
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
