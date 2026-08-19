/**
 * The specimen page the harness photographs.
 *
 * One theme per load (`?theme=dark`), because the app's palettes hang off `:root[data-theme]` and a
 * page showing both at once would have to scope them to a subtree — which is a stylesheet this app
 * does not have, and a snapshot of it would be a snapshot of the harness.
 *
 * `data-ready` is what the harness waits for. Photographing before `document.fonts.ready` catches
 * the fallback face mid-swap, which is exactly the difference the comparison is looking for.
 */
import { createRoot } from "react-dom/client";
import type { JSX } from "react";
import "../src/renderer/styles.css";
import { SPECIMENS } from "./specimens";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset["theme"] = theme;
document.body.style.background = "var(--bg)";
document.body.style.margin = "0";

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
            {s.node}
          </div>
        </figure>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Framed />);

void document.fonts.ready.then(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset["ready"] = "1";
  });
});
